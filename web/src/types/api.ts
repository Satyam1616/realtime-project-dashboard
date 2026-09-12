/**
 * API response types.
 *
 * Hand-mirrored from the server's Zod schemas and Prisma model. In a longer-
 * lived codebase these would be generated (or the schemas lifted into a shared
 * workspace package) so the two cannot drift — see "Known limitations" in
 * README.md. They are duplicated here deliberately rather than accidentally:
 * the alternative for a two-day build is importing server code into the browser
 * bundle, which drags Prisma and the JWT library along with it.
 */

export type Role = 'ADMIN' | 'PROJECT_MANAGER' | 'DEVELOPER';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ProjectStatus = 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED';

export const TASK_STATUSES: readonly TaskStatus[] = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];
/** Declared CRITICAL-first: this is display order, the inverse of the DB enum. */
export const TASK_PRIORITIES: readonly TaskPriority[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarColor: string;
  jobTitle: string | null;
}

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  avatarColor: string;
}

/** `GET /users/assignable` — the assignee picker. Admins and PMs only. */
export interface AssignableUserDto {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarColor: string;
  jobTitle: string | null;
}

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
  assignee: UserSummary | null;
  createdBy: { id: string; name: string } | null;
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  startDate: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  client: { id: string; name: string; company: string | null };
  manager: UserSummary;
  taskCounts: {
    total: number;
    todo: number;
    inProgress: number;
    inReview: number;
    done: number;
    overdue: number;
  };
}

export interface ClientDto {
  id: string;
  name: string;
  company: string | null;
  contactName: string | null;
  contactEmail: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Scoped to the caller: a PM sees only their own projects counted here. */
  projectCount: number;
  /** Admin-only. `null` for a PM, so the list cannot leak portfolio size. */
  totalProjectCount: number | null;
}

export interface TeamUserDto {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarColor: string;
  jobTitle: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  openTasks: number;
  managedProjects: number;
}

/**
 * `GET /projects/:id/members`.
 *
 * Membership is an explicit row, added by an admin or the owning manager. It is
 * one of the two ways a developer gains sight of a project — the other being an
 * assigned task — so a manager can bring someone onto a project before there is
 * any work to give them.
 */
export interface ProjectMemberDto {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarColor: string;
  jobTitle: string | null;
  addedAt: string;
}

/* ------------------------------------------------------------------ *
 * Dashboard — a discriminated union on `variant`
 *
 * The client never asks for a variant: the server picks it from the
 * authenticated principal, so there is no parameter to tamper with. Switching
 * on `variant` rather than on `user.role` means the rendered shape and the
 * fetched data can never disagree.
 * ------------------------------------------------------------------ */

export type StatusCounts = Record<TaskStatus, number>;
export type PriorityCounts = Record<TaskPriority, number>;

export interface PresenceDto {
  onlineCount: number;
  users: Array<{ id: string; name: string; role: Role; avatarColor: string }>;
}

export interface AdminDashboard {
  variant: 'admin';
  totals: {
    projects: number;
    activeProjects: number;
    tasks: number;
    overdueTasks: number;
    clients: number;
    users: number;
  };
  tasksByStatus: StatusCounts;
  tasksByPriority: PriorityCounts;
  /** First paint only; kept live afterwards by `presence:update`. */
  presence: PresenceDto;
  overdueTasks: TaskDto[];
}

export interface ManagerDashboard {
  variant: 'manager';
  totals: { projects: number; activeProjects: number; tasks: number; overdueTasks: number; awaitingReview: number };
  tasksByStatus: StatusCounts;
  tasksByPriority: PriorityCounts;
  projects: Array<{
    id: string;
    name: string;
    status: ProjectStatus;
    dueDate: string | null;
    clientName: string;
    openTasks: number;
    overdueTasks: number;
  }>;
  dueThisWeek: TaskDto[];
}

export interface DeveloperDashboard {
  variant: 'developer';
  totals: { assigned: number; openTasks: number; overdueTasks: number; dueThisWeek: number; completedThisWeek: number };
  tasksByStatus: StatusCounts;
  /** Priority first (CRITICAL → LOW), then nearest deadline. */
  tasks: TaskDto[];
}

export type DashboardDto = AdminDashboard | ManagerDashboard | DeveloperDashboard;

/* ------------------------------------------------------------------ *
 * Envelopes
 * ------------------------------------------------------------------ */

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface CursorPaged<T> {
  items: T[];
  nextCursor: string | number | null;
}

export interface NotificationListDto {
  items: NotificationDto[];
  nextCursor: string | null;
  unread: number;
}

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  taskId: string | null;
  projectId: string | null;
  actorName: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface LoginResponse {
  user: CurrentUser;
  accessToken: string;
  expiresIn: number;
}

/** The structured error envelope every failing route returns. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Array<{ path: string; message: string }> };
  requestId?: string;
}
