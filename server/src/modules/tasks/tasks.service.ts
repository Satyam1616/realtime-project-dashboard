/**
 * Task service — the transactional core of the application.
 *
 * The shape every write follows, and the reason for it:
 *
 *   1. Read the task **through `taskScope(principal)`**, so an out-of-scope id
 *      is a 404 before any authorisation logic runs.
 *   2. `assertCanUpdateTask` — identity, per-role field allowlist, transition
 *      legality.
 *   3. One `$transaction` that writes the task row, appends every
 *      `ActivityEvent` describing the change, and inserts any `Notification`
 *      rows. Either all of it is durable or none of it is; the feed can never
 *      contain an event for a change that did not happen.
 *   4. **After** the commit, push over WebSocket. Emitting inside the
 *      transaction would let a client render a change that then rolled back, and
 *      an append-only feed has no way to retract it.
 *
 * Step 3 is also what satisfies "status changes stored in the database, not
 * derived": the history is rows, written at the moment of the change, not
 * reconstructed from the task's current state.
 */
import { prisma, Prisma, Role, TaskStatus, type TaskPriority } from '../../db/client.js';
import {
  assertCanUpdateTask,
  canDeleteTask,
  taskScope,
  type Principal,
} from '../../access/rbac.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { getIO } from '../../realtime/socket.server.js';
import { emitTaskChanged, emitTaskRemoved, type EventAudience } from '../../realtime/fanout.js';
import type { ActivityEventDto, TaskChangedDto } from '../../realtime/types.js';
import { publishActivity, recordActivity, type RecordActivityInput } from '../activity/activity.service.js';
import {
  createNotification,
  publishNotifications,
  type CreateNotificationInput,
} from '../notifications/notification.service.js';
import { requireManagedProject } from '../projects/projects.service.js';
import { isOverdueNow } from './task.rules.js';
import type { CreateTaskInput, ListTasksQuery, UpdateTaskInput } from './tasks.schemas.js';

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

const TASK_SELECT = {
  id: true,
  number: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  dueDate: true,
  isOverdue: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, name: true, managerId: true } },
  assignee: { select: { id: true, name: true, email: true, avatarColor: true } },
  createdBy: { select: { id: true, name: true } },
} as const;

type TaskRow = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  isOverdue: boolean;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  project: { id: string; name: string; managerId: string };
  assignee: { id: string; name: string; email: string; avatarColor: string } | null;
  createdBy: { id: string; name: string } | null;
};

export interface TaskDto {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  isOverdue: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  project: { id: string; name: string; managerId: string };
  assignee: { id: string; name: string; email: string; avatarColor: string } | null;
  createdBy: { id: string; name: string } | null;
}

export const toTaskDto = (row: TaskRow): TaskDto => ({
  id: row.id,
  number: row.number,
  title: row.title,
  description: row.description,
  status: row.status,
  priority: row.priority,
  dueDate: row.dueDate?.toISOString() ?? null,
  isOverdue: row.isOverdue,
  completedAt: row.completedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  project: row.project,
  assignee: row.assignee,
  createdBy: row.createdBy,
});

/** The narrower payload the board listens for. */
const toTaskChangedDto = (row: TaskRow, changeKind: TaskChangedDto['changeKind']): TaskChangedDto => ({
  id: row.id,
  number: row.number,
  title: row.title,
  status: row.status,
  priority: row.priority,
  dueDate: row.dueDate?.toISOString() ?? null,
  isOverdue: row.isOverdue,
  projectId: row.project.id,
  assigneeId: row.assignee?.id ?? null,
  assigneeName: row.assignee?.name ?? null,
  updatedAt: row.updatedAt.toISOString(),
  changeKind,
});

/**
 * Pushes everything a committed task write produced.
 *
 * Collected into one function so no write path can remember the activity fanout
 * and forget the board update, or vice versa.
 */
const publishTaskWrite = async (
  events: RecordActivityInput[],
  dtos: ActivityEventDto[],
  task: TaskRow,
  changeKind: TaskChangedDto['changeKind'],
  notificationIds: Array<string | null>,
  previousAssigneeId?: string | null,
): Promise<void> => {
  const audience: EventAudience = {
    projectManagerId: task.project.managerId,
    assigneeId: task.assignee?.id ?? null,
  };

  for (const [index, dto] of dtos.entries()) {
    // Each event carries the actor that produced it, so the actor always sees
    // the result of their own action even when the task is not theirs.
    publishActivity(dto, { ...audience, actorId: events[index]?.actorId ?? null });
  }

  const io = getIO();
  if (io) {
    const changed = toTaskChangedDto(task, changeKind);
    await emitTaskChanged(io, changed, audience);

    if (previousAssigneeId && previousAssigneeId !== (task.assignee?.id ?? null)) {
      emitTaskRemoved(io, previousAssigneeId, changed);
    }
  }

  await publishNotifications(notificationIds);
};

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export interface TaskListResult {
  items: TaskDto[];
  total: number;
}

/**
 * The filter builder.
 *
 * `taskScope(principal)` is the first entry and is AND-ed with everything else,
 * so no combination of query parameters can widen what a role sees — a developer
 * passing `?assigneeId=<someone-else>` intersects their own scope with that id
 * and gets nothing.
 */
const buildTaskWhere = (principal: Principal, query: ListTasksQuery): Prisma.TaskWhereInput => {
  const filters: Prisma.TaskWhereInput[] = [taskScope(principal)];

  if (query.projectId) filters.push({ projectId: query.projectId });
  if (query.status) filters.push({ status: { in: query.status } });
  if (query.priority) filters.push({ priority: { in: query.priority } });
  if (query.assigneeId) filters.push({ assigneeId: query.assigneeId });
  if (query.unassigned) filters.push({ assigneeId: null });
  if (query.overdue !== undefined) filters.push({ isOverdue: query.overdue });

  // A due-date range needs both bounds in one clause; two separate `dueDate`
  // filters in the AND array would be fine for Prisma but read worse.
  if (query.dueFrom || query.dueTo) {
    filters.push({
      dueDate: {
        ...(query.dueFrom ? { gte: query.dueFrom } : {}),
        ...(query.dueTo ? { lte: query.dueTo } : {}),
      },
    });
  }

  if (query.q) {
    filters.push({
      OR: [
        { title: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
      ],
    });
  }

  return { AND: filters };
};

const buildTaskOrderBy = (query: ListTasksQuery): Prisma.TaskOrderByWithRelationInput[] => {
  if (query.sort === 'priority') {
    // "Priority, then deadline" — the developer dashboard's ordering. Tasks with
    // no due date sort last rather than jumping to the front.
    return [{ priority: query.order }, { dueDate: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }];
  }
  if (query.sort === 'dueDate') {
    return [{ dueDate: { sort: query.order, nulls: 'last' } }, { priority: 'desc' }];
  }
  return [{ [query.sort]: query.order }];
};

export const listTasks = async (principal: Principal, query: ListTasksQuery): Promise<TaskListResult> => {
  const where = buildTaskWhere(principal, query);

  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where,
      select: TASK_SELECT,
      orderBy: buildTaskOrderBy(query),
      take: query.limit,
      skip: query.offset,
    }),
    prisma.task.count({ where }),
  ]);

  return { items: rows.map(toTaskDto), total };
};

/** 404 — not 403 — when the task exists but is outside the caller's scope. */
export const getTask = async (principal: Principal, id: string): Promise<TaskDto> => {
  const row = await prisma.task.findFirst({
    where: { AND: [{ id }, taskScope(principal)] },
    select: TASK_SELECT,
  });
  if (!row) throw notFound('Task');
  return toTaskDto(row);
};

/* ------------------------------------------------------------------ *
 * Assignee validation
 * ------------------------------------------------------------------ */

/**
 * Resolves and vets a prospective assignee.
 *
 * Rejects inactive accounts so work cannot be parked on a disabled user, and
 * rejects admins because an admin is an operator of the system rather than a
 * member of delivery staff — keeping them out of assignee lists is what makes
 * "tasks by assignee" a meaningful view.
 */
const resolveAssignee = async (assigneeId: string): Promise<{ id: string; name: string }> => {
  const user = await prisma.user.findFirst({
    where: { id: assigneeId, isActive: true },
    select: { id: true, name: true, role: true },
  });
  if (!user) throw badRequest('That assignee does not exist or is inactive.');
  if (user.role === Role.ADMIN) throw badRequest('Tasks cannot be assigned to an administrator.');
  return { id: user.id, name: user.name };
};

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

export const createTask = async (principal: Principal, input: CreateTaskInput): Promise<TaskDto> => {
  // Throws 404 if the project is invisible, 403 if visible but not theirs.
  const project = await requireManagedProject(principal, input.projectId);

  const assignee = input.assigneeId ? await resolveAssignee(input.assigneeId) : null;

  const status = input.status ?? TaskStatus.TODO;
  const dueDate = input.dueDate ?? null;
  // A task created with a due date already in the past is overdue immediately;
  // the sweep would otherwise take up to its interval to notice. Same predicate
  // the job uses.
  const bornOverdue = isOverdueNow({ status, dueDate });

  const { task, events, dtos, notificationIds } = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        projectId: project.id,
        title: input.title,
        description: input.description ?? null,
        status,
        priority: input.priority ?? 'MEDIUM',
        dueDate,
        assigneeId: assignee?.id ?? null,
        createdById: principal.id,
        isOverdue: bornOverdue,
        ...(bornOverdue ? { overdueFlaggedAt: new Date() } : {}),
      },
      select: TASK_SELECT,
    });

    const inputs: RecordActivityInput[] = [
      {
        type: 'TASK_CREATED',
        projectId: project.id,
        projectName: project.name,
        actorId: principal.id,
        actorName: principal.name,
        taskId: created.id,
        taskNumber: created.number,
        taskTitle: created.title,
        toStatus: created.status,
        metadata: { priority: created.priority },
      },
    ];

    if (assignee) {
      inputs.push({
        type: 'TASK_ASSIGNED',
        projectId: project.id,
        projectName: project.name,
        actorId: principal.id,
        actorName: principal.name,
        taskId: created.id,
        taskNumber: created.number,
        taskTitle: created.title,
        metadata: { assigneeId: assignee.id, assigneeName: assignee.name },
      });
    }

    const recorded: ActivityEventDto[] = [];
    for (const activity of inputs) recorded.push(await recordActivity(tx, activity));

    const notifications: Array<string | null> = [];
    if (assignee) {
      notifications.push(
        await createNotification(tx, {
          recipientId: assignee.id,
          actorId: principal.id,
          type: 'TASK_ASSIGNED',
          title: `New task: ${created.title}`,
          body: `${principal.name} assigned you Task #${created.number} in ${project.name}.`,
          taskId: created.id,
          projectId: project.id,
        }),
      );
    }

    return { task: created, events: inputs, dtos: recorded, notificationIds: notifications };
  });

  await publishTaskWrite(events, dtos, task, 'created', notificationIds);
  return toTaskDto(task);
};

/* ------------------------------------------------------------------ *
 * Update — the status-change path
 * ------------------------------------------------------------------ */

export const updateTask = async (
  principal: Principal,
  id: string,
  patch: UpdateTaskInput,
): Promise<TaskDto> => {
  const existing = await prisma.task.findFirst({
    where: { AND: [{ id }, taskScope(principal)] },
    select: TASK_SELECT,
  });
  if (!existing) throw notFound('Task');

  // Identity, per-role field allowlist, and transition legality in one call.
  assertCanUpdateTask(
    principal,
    {
      assigneeId: existing.assignee?.id ?? null,
      status: existing.status,
      project: { managerId: existing.project.managerId },
    },
    patch,
  );

  const previousAssigneeId = existing.assignee?.id ?? null;
  const nextAssignee =
    patch.assigneeId !== undefined && patch.assigneeId !== null && patch.assigneeId !== previousAssigneeId
      ? await resolveAssignee(patch.assigneeId)
      : null;

  const data: Prisma.TaskUncheckedUpdateInput = {};
  const activityInputs: RecordActivityInput[] = [];
  const notificationInputs: CreateNotificationInput[] = [];

  const base = {
    projectId: existing.project.id,
    projectName: existing.project.name,
    actorId: principal.id,
    actorName: principal.name,
    taskId: existing.id,
    taskNumber: existing.number,
    taskTitle: patch.title ?? existing.title,
  } satisfies Partial<RecordActivityInput>;

  /* --- status ------------------------------------------------------ */
  const nextStatus = patch.status !== undefined && patch.status !== existing.status ? patch.status : null;
  if (nextStatus) {
    data.status = nextStatus;
    // `completedAt` is a fact about the row, so it is written here rather than
    // inferred from `status === DONE` at read time.
    data.completedAt = nextStatus === TaskStatus.DONE ? new Date() : null;

    activityInputs.push({
      ...base,
      type: 'TASK_STATUS_CHANGED',
      fromStatus: existing.status,
      toStatus: nextStatus,
    });

    // Spec: the project manager is notified when their task enters review.
    if (nextStatus === TaskStatus.IN_REVIEW) {
      notificationInputs.push({
        recipientId: existing.project.managerId,
        actorId: principal.id,
        type: 'TASK_IN_REVIEW',
        title: `Ready for review: ${base.taskTitle}`,
        body: `${principal.name} moved Task #${existing.number} to In Review in ${existing.project.name}.`,
        taskId: existing.id,
        projectId: existing.project.id,
      });
    }

    // Courtesy the other way: whoever did the work hears that it was signed off.
    if (nextStatus === TaskStatus.DONE && previousAssigneeId) {
      notificationInputs.push({
        recipientId: previousAssigneeId,
        actorId: principal.id,
        type: 'TASK_COMPLETED',
        title: `Task completed: ${base.taskTitle}`,
        body: `${principal.name} marked Task #${existing.number} as Done.`,
        taskId: existing.id,
        projectId: existing.project.id,
      });
    }
  }

  /* --- assignment -------------------------------------------------- */
  if (patch.assigneeId !== undefined && (patch.assigneeId ?? null) !== previousAssigneeId) {
    data.assigneeId = nextAssignee?.id ?? null;

    if (nextAssignee) {
      activityInputs.push({
        ...base,
        type: 'TASK_ASSIGNED',
        metadata: {
          assigneeId: nextAssignee.id,
          assigneeName: nextAssignee.name,
          previousAssigneeId,
        },
      });
      notificationInputs.push({
        recipientId: nextAssignee.id,
        actorId: principal.id,
        type: 'TASK_ASSIGNED',
        title: `Assigned to you: ${base.taskTitle}`,
        body: `${principal.name} assigned you Task #${existing.number} in ${existing.project.name}.`,
        taskId: existing.id,
        projectId: existing.project.id,
      });
    } else {
      activityInputs.push({
        ...base,
        type: 'TASK_UNASSIGNED',
        metadata: { previousAssigneeId, previousAssigneeName: existing.assignee?.name ?? null },
      });
    }
  }

  /* --- priority ---------------------------------------------------- */
  if (patch.priority !== undefined && patch.priority !== existing.priority) {
    data.priority = patch.priority;
    activityInputs.push({
      ...base,
      type: 'TASK_PRIORITY_CHANGED',
      metadata: { from: existing.priority, to: patch.priority },
    });
  }

  /* --- due date ---------------------------------------------------- */
  const previousDue = existing.dueDate;
  const nextDue = patch.dueDate === undefined ? previousDue : patch.dueDate;
  if (patch.dueDate !== undefined && nextDue?.getTime() !== previousDue?.getTime()) {
    data.dueDate = nextDue;
    activityInputs.push({
      ...base,
      type: 'TASK_DUE_DATE_CHANGED',
      metadata: {
        from: previousDue?.toISOString() ?? null,
        to: nextDue?.toISOString() ?? null,
      },
    });
  }

  /* --- plain text edits -------------------------------------------- */
  const textChanges: string[] = [];
  if (patch.title !== undefined && patch.title !== existing.title) {
    data.title = patch.title;
    textChanges.push('title');
  }
  if (patch.description !== undefined && patch.description !== existing.description) {
    data.description = patch.description;
    textChanges.push('description');
  }
  if (textChanges.length > 0) {
    activityInputs.push({ ...base, type: 'TASK_UPDATED', metadata: { changed: textChanges } });
  }

  /* --- overdue reconciliation -------------------------------------- */
  // Not a re-implementation of the scheduler: the sweep is what *discovers*
  // overdue work. This only keeps the flag truthful for the row we are already
  // writing, using the same predicate, so completing a task does not leave it
  // showing as overdue until the next tick.
  const effective = { status: nextStatus ?? existing.status, dueDate: nextDue ?? null };
  const shouldBeOverdue = isOverdueNow(effective);
  if (shouldBeOverdue !== existing.isOverdue) {
    data.isOverdue = shouldBeOverdue;
    data.overdueFlaggedAt = shouldBeOverdue ? new Date() : null;
  }

  if (Object.keys(data).length === 0) {
    // Nothing actually differed. Returning the row unchanged is more useful than
    // a 400, and writing an empty activity event would pollute the feed.
    return toTaskDto(existing);
  }

  const { task, dtos, notificationIds } = await prisma.$transaction(async (tx) => {
    const updated = await tx.task.update({ where: { id }, data, select: TASK_SELECT });

    const recorded: ActivityEventDto[] = [];
    for (const activity of activityInputs) recorded.push(await recordActivity(tx, activity));

    const notifications: Array<string | null> = [];
    for (const notification of notificationInputs) {
      notifications.push(await createNotification(tx, notification));
    }

    return { task: updated, dtos: recorded, notificationIds: notifications };
  });

  const changeKind: TaskChangedDto['changeKind'] = nextStatus
    ? 'status'
    : data.assigneeId !== undefined
      ? 'assignment'
      : 'updated';

  await publishTaskWrite(activityInputs, dtos, task, changeKind, notificationIds, previousAssigneeId);
  return toTaskDto(task);
};

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

/**
 * Admin, or the manager of the project the task belongs to.
 *
 * The `TASK_DELETED` event is appended *before* the row goes away. Because
 * `ActivityEvent.taskId` is `onDelete: SetNull` while the task number and title
 * are denormalised onto the event, the audit trail survives the deletion with
 * enough context to still read correctly — which is the whole reason those
 * columns are duplicated.
 */
export const deleteTask = async (principal: Principal, id: string): Promise<void> => {
  const existing = await prisma.task.findFirst({
    where: { AND: [{ id }, taskScope(principal)] },
    select: TASK_SELECT,
  });
  if (!existing) throw notFound('Task');

  if (!canDeleteTask(principal, { project: { managerId: existing.project.managerId } })) {
    throw forbidden('Only an admin or the manager of this project can delete a task.');
  }

  const event = await prisma.$transaction(async (tx) => {
    const recorded = await recordActivity(tx, {
      type: 'TASK_DELETED',
      projectId: existing.project.id,
      projectName: existing.project.name,
      actorId: principal.id,
      actorName: principal.name,
      taskId: existing.id,
      taskNumber: existing.number,
      taskTitle: existing.title,
      fromStatus: existing.status,
      metadata: { assigneeName: existing.assignee?.name ?? null },
    });

    await tx.task.delete({ where: { id } });
    return recorded;
  });

  publishActivity(event, {
    projectManagerId: existing.project.managerId,
    assigneeId: existing.assignee?.id ?? null,
    actorId: principal.id,
  });

  const io = getIO();
  if (io) {
    await emitTaskChanged(io, toTaskChangedDto(existing, 'deleted'), {
      projectManagerId: existing.project.managerId,
      assigneeId: existing.assignee?.id ?? null,
      actorId: principal.id,
    });
  }
};
