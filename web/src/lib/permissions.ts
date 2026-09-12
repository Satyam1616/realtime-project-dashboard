/**
 * Client-side mirror of the server's capability predicates.
 *
 * **This is cosmetic.** Its only job is to avoid rendering a control that would
 * produce a 403 — showing a developer a priority dropdown that always fails is
 * worse UX than not showing it. Every rule below is independently enforced in
 * `server/src/access/rbac.ts`, applied in route preHandlers *and* again in the
 * service layer, and a request that bypasses this file entirely is rejected
 * there. Deleting this file would change what the UI offers and nothing about
 * what the API permits.
 */
import type { CurrentUser, TaskDto, TaskStatus } from '../types/api';

/**
 * The two shapes a project arrives in: `ProjectDto` nests the manager (it
 * carries their name and colour for display), while `TaskDto.project` carries
 * only `managerId`. Accepting both keeps the call sites honest instead of
 * making each one remember which it holds.
 */
type ManagedProject = { managerId: string } | { manager: { id: string } };

const managerIdOf = (project: ManagedProject): string =>
  'managerId' in project ? project.managerId : project.manager.id;

export const canManageProject = (user: CurrentUser, project: ManagedProject): boolean =>
  user.role === 'ADMIN' || (user.role === 'PROJECT_MANAGER' && managerIdOf(project) === user.id);

export const canCreateProject = (user: CurrentUser): boolean =>
  user.role === 'ADMIN' || user.role === 'PROJECT_MANAGER';

export const canCreateTaskIn = (user: CurrentUser, project: ManagedProject): boolean =>
  canManageProject(user, project);

export const canUpdateTask = (user: CurrentUser, task: TaskDto): boolean => {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'PROJECT_MANAGER') return task.project.managerId === user.id;
  return task.assignee?.id === user.id;
};

export const canDeleteTask = (user: CurrentUser, task: TaskDto): boolean =>
  canManageProject(user, task.project);

/** Developers may only change `status`; managers and admins own every field. */
export const canEditTaskFields = (user: CurrentUser, task: TaskDto): boolean =>
  user.role !== 'DEVELOPER' && canUpdateTask(user, task);

/**
 * Statuses this user may move a task *to*.
 *
 * Developers push work as far as In Review; signing off as Done belongs to the
 * admin or the owning manager. That gate is what makes the "moved to In Review"
 * notification meaningful.
 */
export const allowedStatusTargets = (user: CurrentUser): TaskStatus[] =>
  user.role === 'DEVELOPER'
    ? ['TODO', 'IN_PROGRESS', 'IN_REVIEW']
    : ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];

export const canManageUsers = (user: CurrentUser): boolean => user.role === 'ADMIN';
export const canManageClients = (user: CurrentUser): boolean => user.role === 'ADMIN';
export const canViewClients = (user: CurrentUser): boolean =>
  user.role === 'ADMIN' || user.role === 'PROJECT_MANAGER';
