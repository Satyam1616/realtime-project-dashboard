/**
 * Overdue sweep.
 *
 * The brief requires that a task past its due date is flagged "via a scheduled
 * background job, not on page load", and the distinction matters for more than
 * tidiness: deriving the flag at render time means two users looking at the same
 * board can disagree, the flag never produces an activity event, and nobody is
 * ever notified. Here the transition is a *write* — one row change, one feed
 * entry, one notification — so it is observable, ordered, and identical for
 * everyone.
 *
 * Concurrency: the claim and the events it produces happen in a single
 * transaction, and the claim re-checks `isOverdue: false` inside it. Two API
 * instances running the same cron minute therefore cannot both flag a task —
 * the second blocks on the row lock, re-evaluates the predicate after the first
 * commits, and matches nothing. No advisory lock or external queue is needed for
 * exactly-once semantics here, because the row being updated *is* the lock.
 *
 * The sweep also *clears* the flag: a due date pushed into the future, or a task
 * completed, must stop being overdue. That direction produces no activity entry
 * — it is a correction, not news — and it is what keeps the denormalised
 * `isOverdue` column trustworthy enough to index and count against.
 */
import { prisma, Prisma, TaskStatus } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { getIO } from '../realtime/socket.server.js';
import { emitTaskChanged, type EventAudience } from '../realtime/fanout.js';
import type { ActivityEventDto } from '../realtime/types.js';
import { publishActivity, recordActivity } from '../modules/activity/activity.service.js';
import { createNotification, publishNotifications } from '../modules/notifications/notification.service.js';
import { OPEN_STATUSES } from '../modules/tasks/task.rules.js';

/** Bounds the transaction so a large backlog cannot hold locks for minutes. */
const BATCH_SIZE = 200;

/** Events raised by the scheduler have no human actor; the feed says so. */
const SYSTEM_ACTOR = 'System';

const SWEEP_SELECT = {
  id: true,
  number: true,
  title: true,
  status: true,
  priority: true,
  dueDate: true,
  assigneeId: true,
  project: { select: { id: true, name: true, managerId: true } },
  assignee: { select: { id: true, name: true } },
} as const;

export interface SweepResult {
  flagged: number;
  cleared: number;
}

/**
 * Drops the flag from anything that is no longer late.
 *
 * Write paths already reconcile the row they touch, so this normally matches
 * nothing. It exists for the cases they cannot cover: a row changed by a
 * migration, a seed, or a direct database edit.
 */
const clearStaleFlags = async (now: Date): Promise<number> => {
  const { count } = await prisma.task.updateMany({
    where: {
      isOverdue: true,
      OR: [{ status: TaskStatus.DONE }, { dueDate: null }, { dueDate: { gte: now } }],
    },
    data: { isOverdue: false },
  });
  return count;
};

export const sweepOverdueTasks = async (now: Date = new Date()): Promise<SweepResult> => {
  const cleared = await clearStaleFlags(now);

  const overdueWhere: Prisma.TaskWhereInput = {
    isOverdue: false,
    status: { in: [...OPEN_STATUSES] },
    dueDate: { lt: now },
  };

  // `updateMany` has no `take`, so the batch is chosen first and the claim is
  // narrowed to those ids — the `isOverdue: false` re-check inside the
  // transaction is what makes the claim safe against a second instance.
  const candidates = await prisma.task.findMany({
    where: overdueWhere,
    select: { id: true },
    orderBy: { dueDate: 'asc' },
    take: BATCH_SIZE,
  });

  if (candidates.length === 0) {
    return { flagged: 0, cleared };
  }

  const ids = candidates.map((row) => row.id);

  const { tasks, events, notificationIds } = await prisma.$transaction(async (tx) => {
    const claimed = await tx.task.updateManyAndReturn({
      where: { id: { in: ids }, isOverdue: false, status: { in: [...OPEN_STATUSES] }, dueDate: { lt: now } },
      data: { isOverdue: true },
      select: { id: true },
    });

    if (claimed.length === 0) {
      return { tasks: [], events: [] as ActivityEventDto[], notificationIds: [] as Array<string | null> };
    }

    // Re-read with the relations the feed and the board need. `updateManyAndReturn`
    // cannot select through relations, and the rows are already locked by the
    // update above, so this cannot see a competing write.
    const rows = await tx.task.findMany({
      where: { id: { in: claimed.map((row) => row.id) } },
      select: SWEEP_SELECT,
    });

    const recorded: ActivityEventDto[] = [];
    const notifications: Array<string | null> = [];

    for (const task of rows) {
      recorded.push(
        await recordActivity(tx, {
          type: 'TASK_OVERDUE',
          projectId: task.project.id,
          projectName: task.project.name,
          actorId: null,
          actorName: SYSTEM_ACTOR,
          taskId: task.id,
          taskNumber: task.number,
          taskTitle: task.title,
          metadata: {
            dueDate: task.dueDate?.toISOString() ?? null,
            status: task.status,
            priority: task.priority,
          },
        }),
      );

      // Only the assignee is notified. The owning manager already sees the
      // event in their feed and the count on their dashboard, and a badge per
      // late task across a whole portfolio is noise they would learn to ignore.
      if (task.assigneeId) {
        notifications.push(
          await createNotification(tx, {
            recipientId: task.assigneeId,
            actorId: null,
            type: 'TASK_OVERDUE',
            title: `Task #${task.number} is overdue`,
            body: `"${task.title}" was due ${task.dueDate?.toDateString() ?? 'earlier'} and is still ${task.status.replace('_', ' ').toLowerCase()}.`,
            taskId: task.id,
            projectId: task.project.id,
          }),
        );
      }
    }

    return { tasks: rows, events: recorded, notificationIds: notifications };
  });

  // Everything below happens after the commit — see the invariant in
  // activity.service.ts.
  const io = getIO();

  for (const [index, event] of events.entries()) {
    const task = tasks[index];
    if (!task) continue;

    const audience: EventAudience = {
      projectManagerId: task.project.managerId,
      assigneeId: task.assigneeId,
      actorId: null,
    };

    publishActivity(event, audience);

    if (io) {
      await emitTaskChanged(
        io,
        {
          id: task.id,
          number: task.number,
          title: task.title,
          status: task.status,
          priority: task.priority,
          dueDate: task.dueDate?.toISOString() ?? null,
          isOverdue: true,
          projectId: task.project.id,
          assigneeId: task.assigneeId,
          assigneeName: task.assignee?.name ?? null,
          updatedAt: new Date().toISOString(),
          changeKind: 'updated',
        },
        audience,
      );
    }
  }

  await publishNotifications(notificationIds);

  if (tasks.length > 0 || cleared > 0) {
    logger.info({ flagged: tasks.length, cleared }, 'overdue sweep complete');
  }

  return { flagged: tasks.length, cleared };
};
