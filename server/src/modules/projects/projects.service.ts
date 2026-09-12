/**
 * Projects service.
 *
 * Every read AND every write path starts from `projectScope(principal)`. That is
 * the single mechanism keeping one project manager out of another's portfolio:
 * a PM asking for a project they do not own gets an empty result set, which
 * surfaces as a 404 — the same answer they get for an id that does not exist, so
 * the endpoint cannot be used to enumerate other managers' project ids.
 */
import { prisma, Prisma, Role, type ProjectStatus } from '../../db/client.js';
import {
  assertCanManageProject,
  canCreateProject,
  isAdmin,
  projectScope,
  type Principal,
} from '../../access/rbac.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { publishActivity, recordActivity } from '../activity/activity.service.js';
import { createNotification, publishNotifications } from '../notifications/notification.service.js';
import type { CreateProjectInput, ListProjectsQuery, UpdateProjectInput } from './projects.schemas.js';

const PROJECT_SUMMARY_SELECT = {
  id: true,
  name: true,
  description: true,
  status: true,
  startDate: true,
  dueDate: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { id: true, name: true, company: true } },
  manager: { select: { id: true, name: true, email: true, avatarColor: true } },
} as const;

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  startDate: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  client: { id: string; name: string; company: string | null };
  manager: { id: string; name: string; email: string; avatarColor: string };
  taskCounts: { total: number; todo: number; inProgress: number; inReview: number; done: number; overdue: number };
}

/**
 * Per-status task counts for a set of projects.
 *
 * One `groupBy` for the whole page rather than a count per project — the N+1
 * version of this was the obvious way to write it and would issue 6 queries per
 * project row.
 *
 * The counts are themselves role-scoped: a developer sees only their own tasks
 * reflected in the numbers, so the badge on a project card agrees with the task
 * list they can actually open.
 */
const taskCountsFor = async (
  projectIds: string[],
  taskFilter: Prisma.TaskWhereInput,
): Promise<Map<string, ProjectSummary['taskCounts']>> => {
  const empty = (): ProjectSummary['taskCounts'] => ({
    total: 0,
    todo: 0,
    inProgress: 0,
    inReview: 0,
    done: 0,
    overdue: 0,
  });

  const result = new Map<string, ProjectSummary['taskCounts']>(projectIds.map((id) => [id, empty()]));
  if (projectIds.length === 0) return result;

  const [byStatus, overdue] = await Promise.all([
    prisma.task.groupBy({
      by: ['projectId', 'status'],
      where: { AND: [{ projectId: { in: projectIds } }, taskFilter] },
      _count: { _all: true },
    }),
    prisma.task.groupBy({
      by: ['projectId'],
      where: { AND: [{ projectId: { in: projectIds }, isOverdue: true }, taskFilter] },
      _count: { _all: true },
    }),
  ]);

  for (const row of byStatus) {
    const counts = result.get(row.projectId);
    if (!counts) continue;
    const n = row._count._all;
    counts.total += n;
    if (row.status === 'TODO') counts.todo = n;
    else if (row.status === 'IN_PROGRESS') counts.inProgress = n;
    else if (row.status === 'IN_REVIEW') counts.inReview = n;
    else if (row.status === 'DONE') counts.done = n;
  }

  for (const row of overdue) {
    const counts = result.get(row.projectId);
    if (counts) counts.overdue = row._count._all;
  }

  return result;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  startDate: Date | null;
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  client: { id: string; name: string; company: string | null };
  manager: { id: string; name: string; email: string; avatarColor: string };
};

const toSummary = (row: ProjectRow, counts: ProjectSummary['taskCounts']): ProjectSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  startDate: row.startDate?.toISOString() ?? null,
  dueDate: row.dueDate?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  client: row.client,
  manager: row.manager,
  taskCounts: counts,
});

/**
 * Task visibility used for the counts above.
 *
 * Deliberately *not* `taskScope()`: for a PM or admin looking at a project they
 * can see, the card should show the whole project's progress. Only a developer's
 * counts are narrowed to their own work.
 */
const countScopeFor = (principal: Principal): Prisma.TaskWhereInput =>
  principal.role === Role.DEVELOPER ? { assigneeId: principal.id } : {};

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export interface ProjectListResult {
  items: ProjectSummary[];
  total: number;
}

export const listProjects = async (
  principal: Principal,
  query: ListProjectsQuery,
): Promise<ProjectListResult> => {
  const filters: Prisma.ProjectWhereInput[] = [projectScope(principal)];

  if (query.status) filters.push({ status: query.status });
  if (query.clientId) filters.push({ clientId: query.clientId });
  // Only an admin can pivot by manager; for a PM the scope already fixes it,
  // and honouring the parameter for them would be a no-op at best.
  if (query.managerId && isAdmin(principal)) filters.push({ managerId: query.managerId });
  if (query.q) {
    filters.push({
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
        { client: { name: { contains: query.q, mode: 'insensitive' } } },
      ],
    });
  }

  const where: Prisma.ProjectWhereInput = { AND: filters };

  const [rows, total] = await Promise.all([
    prisma.project.findMany({
      where,
      select: PROJECT_SUMMARY_SELECT,
      orderBy: { [query.sort]: query.order },
      take: query.limit,
      skip: query.offset,
    }),
    prisma.project.count({ where }),
  ]);

  const counts = await taskCountsFor(
    rows.map((row) => row.id),
    countScopeFor(principal),
  );

  return {
    items: rows.map((row) => toSummary(row, counts.get(row.id)!)),
    total,
  };
};

/** Throws 404 when the project exists but is outside the caller's scope. */
export const getProject = async (principal: Principal, id: string): Promise<ProjectSummary> => {
  const row = await prisma.project.findFirst({
    where: { AND: [{ id }, projectScope(principal)] },
    select: PROJECT_SUMMARY_SELECT,
  });

  if (!row) throw notFound('Project');

  const counts = await taskCountsFor([row.id], countScopeFor(principal));
  return toSummary(row, counts.get(row.id)!);
};

export interface ProjectMemberDto {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarColor: string;
  jobTitle: string | null;
  addedAt: string;
}

export const listProjectMembers = async (principal: Principal, projectId: string): Promise<ProjectMemberDto[]> => {
  // Confirms visibility first; `getProject` throws 404 if out of scope.
  await getProject(principal, projectId);

  const rows = await prisma.projectMember.findMany({
    where: { projectId },
    orderBy: { user: { name: 'asc' } },
    select: {
      addedAt: true,
      user: { select: { id: true, name: true, email: true, role: true, avatarColor: true, jobTitle: true } },
    },
  });

  return rows.map((row) => ({
    id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.user.role,
    avatarColor: row.user.avatarColor,
    jobTitle: row.user.jobTitle,
    addedAt: row.addedAt.toISOString(),
  }));
};

/** The manager row for a project, used by task writes to authorise and to fan out. */
export const requireManagedProject = async (
  principal: Principal,
  projectId: string,
): Promise<{ id: string; name: string; managerId: string }> => {
  const project = await prisma.project.findFirst({
    where: { AND: [{ id: projectId }, projectScope(principal)] },
    select: { id: true, name: true, managerId: true },
  });

  if (!project) throw notFound('Project');
  assertCanManageProject(principal, project);
  return project;
};

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export const createProject = async (principal: Principal, input: CreateProjectInput): Promise<ProjectSummary> => {
  if (!canCreateProject(principal)) {
    throw forbidden('Only admins and project managers can create projects.');
  }

  // A PM always owns what they create. Only an admin may nominate a different
  // manager — otherwise a PM could create a project owned by a colleague, or
  // assign themselves as manager of someone else's work.
  let managerId = principal.id;
  if (input.managerId && input.managerId !== principal.id) {
    if (!isAdmin(principal)) {
      throw forbidden('Only an admin can assign a project to a different manager.');
    }
    managerId = input.managerId;
  }

  const manager = await prisma.user.findFirst({
    where: { id: managerId, isActive: true },
    select: { id: true, role: true },
  });
  if (!manager) throw badRequest('The nominated manager does not exist or is inactive.');
  if (manager.role === Role.DEVELOPER) {
    throw badRequest('A developer cannot be the manager of a project.');
  }

  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true } });
  if (!client) throw badRequest('The specified client does not exist.');

  const { project, event } = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        clientId: input.clientId,
        managerId,
        status: input.status ?? 'ACTIVE',
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
      },
      select: PROJECT_SUMMARY_SELECT,
    });

    const activity = await recordActivity(tx, {
      type: 'PROJECT_CREATED',
      projectId: created.id,
      projectName: created.name,
      actorId: principal.id,
      actorName: principal.name,
      metadata: { clientName: created.client.name },
    });

    return { project: created, event: activity };
  });

  publishActivity(event, { projectManagerId: managerId, actorId: principal.id });

  const counts = await taskCountsFor([project.id], countScopeFor(principal));
  return toSummary(project, counts.get(project.id)!);
};

export const updateProject = async (
  principal: Principal,
  id: string,
  patch: UpdateProjectInput,
): Promise<ProjectSummary> => {
  const existing = await prisma.project.findFirst({
    where: { AND: [{ id }, projectScope(principal)] },
    select: { id: true, name: true, managerId: true, status: true },
  });
  if (!existing) throw notFound('Project');
  assertCanManageProject(principal, existing);

  if (patch.clientId) {
    const client = await prisma.client.findUnique({ where: { id: patch.clientId }, select: { id: true } });
    if (!client) throw badRequest('The specified client does not exist.');
  }

  const { project, event } = await prisma.$transaction(async (tx) => {
    const updated = await tx.project.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.clientId !== undefined ? { clientId: patch.clientId } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
        ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
      },
      select: PROJECT_SUMMARY_SELECT,
    });

    const activity = await recordActivity(tx, {
      type: 'PROJECT_UPDATED',
      projectId: updated.id,
      projectName: updated.name,
      actorId: principal.id,
      actorName: principal.name,
      metadata: { changed: Object.keys(patch) },
    });

    return { project: updated, event: activity };
  });

  publishActivity(event, { projectManagerId: existing.managerId, actorId: principal.id });

  const counts = await taskCountsFor([project.id], countScopeFor(principal));
  return toSummary(project, counts.get(project.id)!);
};

/**
 * Admin-only. Cascades to tasks and their activity history, which is exactly
 * why a project manager cannot do it.
 */
export const deleteProject = async (principal: Principal, id: string): Promise<void> => {
  if (!isAdmin(principal)) {
    throw forbidden('Only an admin can delete a project.');
  }
  const existing = await prisma.project.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('Project');

  await prisma.project.delete({ where: { id } });
};

export const addProjectMember = async (
  principal: Principal,
  projectId: string,
  userId: string,
): Promise<ProjectMemberDto[]> => {
  const project = await requireManagedProject(principal, projectId);

  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true },
    select: { id: true, name: true },
  });
  if (!user) throw badRequest('That user does not exist or is inactive.');

  const { event, notificationId } = await prisma.$transaction(async (tx) => {
    await tx.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId },
      update: {},
    });

    const activity = await recordActivity(tx, {
      type: 'PROJECT_MEMBER_ADDED',
      projectId: project.id,
      projectName: project.name,
      actorId: principal.id,
      actorName: principal.name,
      metadata: { memberId: user.id, memberName: user.name },
    });

    const notification = await createNotification(tx, {
      recipientId: user.id,
      actorId: principal.id,
      type: 'PROJECT_MEMBER_ADDED',
      title: `Added to ${project.name}`,
      body: `${principal.name} added you to the project “${project.name}”.`,
      projectId: project.id,
    });

    return { event: activity, notificationId: notification };
  });

  // Both pushes happen only after the commit — see the header of
  // activity.service.ts for why emitting inside the transaction is unsafe.
  publishActivity(event, { projectManagerId: project.managerId, actorId: principal.id });
  await publishNotifications([notificationId]);

  return listProjectMembers(principal, projectId);
};

export const removeProjectMember = async (
  principal: Principal,
  projectId: string,
  userId: string,
): Promise<ProjectMemberDto[]> => {
  const project = await requireManagedProject(principal, projectId);

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { user: { select: { id: true, name: true } } },
  });
  if (!membership) throw notFound('Project member');

  const event = await prisma.$transaction(async (tx) => {
    await tx.projectMember.delete({ where: { projectId_userId: { projectId, userId } } });

    return recordActivity(tx, {
      type: 'PROJECT_MEMBER_REMOVED',
      projectId: project.id,
      projectName: project.name,
      actorId: principal.id,
      actorName: principal.name,
      metadata: { memberId: membership.user.id, memberName: membership.user.name },
    });
  });

  publishActivity(event, { projectManagerId: project.managerId, actorId: principal.id });

  return listProjectMembers(principal, projectId);
};
