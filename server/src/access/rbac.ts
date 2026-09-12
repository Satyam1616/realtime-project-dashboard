/**
 * Central authorisation module — the single source of truth for "who can see
 * and do what".
 *
 * Two kinds of rule live here, and the distinction matters:
 *
 *   1. **Visibility scopes** (`projectScope`, `taskScope`, `activityScope`)
 *      return Prisma `where` fragments that are AND-ed into *every* read. A
 *      handler never fetches a row and then checks ownership — it asks the
 *      database for rows the principal is allowed to see. Out-of-scope rows are
 *      therefore indistinguishable from rows that do not exist, which is why a
 *      developer probing `GET /api/projects/<a-PM's-id>` gets `404`, not `403`:
 *      a `403` would confirm the id is real.
 *
 *   2. **Capabilities** (`canCreateProject`, `assertCanUpdateTask`, ...) are
 *      predicates for writes, including a per-role *field allowlist* so a
 *      developer who is allowed to touch a task at all still cannot change its
 *      priority, assignee or due date.
 *
 * Nothing here reads from the network or the database, so all of it is directly
 * unit-testable — see test/rbac.test.ts and test/access.integration.test.ts.
 *
 * The frontend hides controls a role cannot use, but that is cosmetic only. The
 * rules below are the enforcement point, applied in route preHandlers and in the
 * service layer.
 */
import { forbidden } from '../lib/errors.js';
import { Role, TaskStatus, type Prisma } from '../db/client.js';

/** The authenticated caller, resolved fresh from the database on every request. */
export interface Principal {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export const isAdmin = (p: Principal): boolean => p.role === Role.ADMIN;
export const isManager = (p: Principal): boolean => p.role === Role.PROJECT_MANAGER;
export const isDeveloper = (p: Principal): boolean => p.role === Role.DEVELOPER;

/* ------------------------------------------------------------------ *
 * 1. Visibility scopes
 * ------------------------------------------------------------------ */

/**
 * Projects the principal may read.
 *
 * - Admin: everything.
 * - Project manager: only projects they own. This is the rule that keeps one
 *   PM out of another PM's portfolio.
 * - Developer: projects they hold a task in, or have been added to as a member.
 *   They need this to render the project name beside their tasks; it exposes no
 *   task data, because tasks are scoped separately and more tightly.
 */
export const projectScope = (p: Principal): Prisma.ProjectWhereInput => {
  switch (p.role) {
    case Role.ADMIN:
      return {};
    case Role.PROJECT_MANAGER:
      return { managerId: p.id };
    case Role.DEVELOPER:
      return {
        OR: [{ tasks: { some: { assigneeId: p.id } } }, { members: { some: { userId: p.id } } }],
      };
  }
};

/**
 * Tasks the principal may read.
 *
 * A developer sees *only* their own assignments — never a peer's — which is
 * enforced as `assigneeId = me` rather than "tasks in my projects".
 */
export const taskScope = (p: Principal): Prisma.TaskWhereInput => {
  switch (p.role) {
    case Role.ADMIN:
      return {};
    case Role.PROJECT_MANAGER:
      return { project: { managerId: p.id } };
    case Role.DEVELOPER:
      return { assigneeId: p.id };
  }
};

/**
 * Activity events the principal may read. The live socket fanout in
 * src/realtime/fanout.ts derives its recipient set from exactly these same
 * rules, so the real-time feed and the database catch-up query can never
 * disagree about what a role is allowed to see.
 *
 * A developer's feed is restricted to events attached to a task assigned to
 * them, so project-level events (`taskId IS NULL`) are excluded for them by
 * construction.
 */
export const activityScope = (p: Principal): Prisma.ActivityEventWhereInput => {
  switch (p.role) {
    case Role.ADMIN:
      return {};
    case Role.PROJECT_MANAGER:
      return { project: { managerId: p.id } };
    case Role.DEVELOPER:
      return { task: { assigneeId: p.id } };
  }
};

/** Notifications are addressed, so the scope is trivially the recipient. */
export const notificationScope = (p: Principal): Prisma.NotificationWhereInput => ({ recipientId: p.id });

/* ------------------------------------------------------------------ *
 * 2. Capabilities
 * ------------------------------------------------------------------ */

export const canManageUsers = (p: Principal): boolean => isAdmin(p);
export const canManageClients = (p: Principal): boolean => isAdmin(p);
/** PMs need to read the client list to attach a project to a client. */
export const canReadClients = (p: Principal): boolean => isAdmin(p) || isManager(p);
export const canCreateProject = (p: Principal): boolean => isAdmin(p) || isManager(p);

/** Write access to a project: admins anywhere, a PM only on projects they own. */
export const canManageProject = (p: Principal, project: { managerId: string }): boolean =>
  isAdmin(p) || (isManager(p) && project.managerId === p.id);

export const assertCanManageProject = (p: Principal, project: { managerId: string }): void => {
  if (!canManageProject(p, project)) {
    throw forbidden('Only an admin or the project manager who owns this project can modify it.');
  }
};

/** Deleting a project destroys its tasks and audit trail, so it is admin-only. */
export const canDeleteProject = (p: Principal): boolean => isAdmin(p);

/* ---------------------------- Tasks ---------------------------- */

/**
 * Fields each role is permitted to write on a task.
 *
 * A developer may move a task along the board and nothing else — they cannot
 * reassign work to someone else, change its priority, or move its deadline.
 */
const TASK_WRITABLE_FIELDS = {
  [Role.ADMIN]: ['title', 'description', 'status', 'priority', 'dueDate', 'assigneeId'],
  [Role.PROJECT_MANAGER]: ['title', 'description', 'status', 'priority', 'dueDate', 'assigneeId'],
  [Role.DEVELOPER]: ['status'],
} as const satisfies Record<Role, readonly string[]>;

export type TaskWritableField = (typeof TASK_WRITABLE_FIELDS)[Role][number];

export const writableTaskFields = (p: Principal): readonly string[] => TASK_WRITABLE_FIELDS[p.role];

/**
 * Status transitions a developer is allowed to perform.
 *
 * Developers push work up to `IN_REVIEW`; only an admin or the owning PM can
 * sign it off as `DONE`. That review gate is what gives the "task moved to In
 * Review" notification to the PM its meaning — without it a developer could
 * self-approve and the review step would be decorative.
 */
const DEVELOPER_FORBIDDEN_STATUSES: readonly TaskStatus[] = [TaskStatus.DONE];

export const canCreateTaskIn = (p: Principal, project: { managerId: string }): boolean =>
  canManageProject(p, project);

/**
 * May the principal touch this task at all?
 *
 * Note this takes the task's *project owner* alongside the task, because a PM's
 * authority over a task derives from owning the project, not from the task row.
 */
export const canUpdateTask = (
  p: Principal,
  task: { assigneeId: string | null; project: { managerId: string } },
): boolean => {
  if (isAdmin(p)) return true;
  if (isManager(p)) return task.project.managerId === p.id;
  return task.assigneeId === p.id;
};

export interface TaskPatch {
  title?: unknown;
  description?: unknown;
  status?: TaskStatus;
  priority?: unknown;
  dueDate?: unknown;
  assigneeId?: unknown;
}

/**
 * The full write check for a task update: identity, then field allowlist, then
 * transition legality. Throws a structured 403 naming the offending field, so
 * the client gets an actionable message rather than a bare "forbidden".
 */
export const assertCanUpdateTask = (
  p: Principal,
  task: { assigneeId: string | null; status: TaskStatus; project: { managerId: string } },
  patch: TaskPatch,
): void => {
  if (!canUpdateTask(p, task)) {
    throw forbidden('You can only update tasks assigned to you or in projects you manage.');
  }

  const allowed = writableTaskFields(p);
  const attempted = Object.keys(patch).filter((key) => patch[key as keyof TaskPatch] !== undefined);
  const rejected = attempted.filter((key) => !allowed.includes(key));

  if (rejected.length > 0) {
    throw forbidden(
      `Your role may only change: ${allowed.join(', ')}. Not permitted: ${rejected.join(', ')}.`,
    );
  }

  if (
    patch.status !== undefined &&
    isDeveloper(p) &&
    DEVELOPER_FORBIDDEN_STATUSES.includes(patch.status)
  ) {
    throw forbidden(
      'Developers move work to In Review; an admin or the project manager marks it Done.',
    );
  }
};

export const canDeleteTask = (p: Principal, task: { project: { managerId: string } }): boolean =>
  canManageProject(p, task.project);

/* ------------------------------------------------------------------ *
 * Dashboard shape
 * ------------------------------------------------------------------ */

/** Each role gets a different dashboard payload; the server decides which. */
export const dashboardVariant = (p: Principal): 'admin' | 'manager' | 'developer' => {
  switch (p.role) {
    case Role.ADMIN:
      return 'admin';
    case Role.PROJECT_MANAGER:
      return 'manager';
    case Role.DEVELOPER:
      return 'developer';
  }
};
