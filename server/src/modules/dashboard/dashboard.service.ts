/**
 * Dashboard aggregates.
 *
 * Each role gets a *different payload from a different query*, decided on the
 * server. The alternative — one fat endpoint plus frontend filtering — would
 * mean shipping an admin's global totals to a developer's browser and trusting
 * the UI not to render them, which is exactly the mistake the brief calls out.
 *
 * All counts go through `groupBy`/`count` with the role scope AND-ed in, so the
 * numbers a role sees are the numbers that role could reproduce by paging
 * through the corresponding list endpoint.
 */
import { prisma, Prisma, Role, TaskStatus, type TaskPriority } from '../../db/client.js';
import { projectScope, taskScope, type Principal } from '../../access/rbac.js';
import { presenceSnapshot } from '../../realtime/presence.js';
import type { PresenceDto } from '../../realtime/types.js';
import { toTaskDto, type TaskDto } from '../tasks/tasks.service.js';

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

export type StatusCounts = Record<TaskStatus, number>;
export type PriorityCounts = Record<TaskPriority, number>;

const emptyStatusCounts = (): StatusCounts => ({
  TODO: 0,
  IN_PROGRESS: 0,
  IN_REVIEW: 0,
  DONE: 0,
});

const emptyPriorityCounts = (): PriorityCounts => ({
  LOW: 0,
  MEDIUM: 0,
  HIGH: 0,
  CRITICAL: 0,
});

const tasksByStatus = async (where: Prisma.TaskWhereInput): Promise<StatusCounts> => {
  const rows = await prisma.task.groupBy({ by: ['status'], where, _count: { _all: true } });
  const counts = emptyStatusCounts();
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
};

const tasksByPriority = async (where: Prisma.TaskWhereInput): Promise<PriorityCounts> => {
  const rows = await prisma.task.groupBy({ by: ['priority'], where, _count: { _all: true } });
  const counts = emptyPriorityCounts();
  for (const row of rows) counts[row.priority] = row._count._all;
  return counts;
};

/** Start of today through end of the seventh day — "due this week". */
const thisWeek = (): { from: Date; to: Date } => {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  to.setHours(23, 59, 59, 999);
  return { from, to };
};

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

/* ------------------------------------------------------------------ *
 * Payloads
 * ------------------------------------------------------------------ */

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
  /**
   * Seeded from the in-memory presence registry and kept live thereafter by
   * `presence:update` over the socket — the HTTP value is only the first paint.
   */
  presence: PresenceDto;
  overdueTasks: TaskDto[];
}

export interface ManagerDashboard {
  variant: 'manager';
  totals: {
    projects: number;
    activeProjects: number;
    tasks: number;
    overdueTasks: number;
    awaitingReview: number;
  };
  tasksByStatus: StatusCounts;
  tasksByPriority: PriorityCounts;
  projects: Array<{
    id: string;
    name: string;
    status: string;
    dueDate: string | null;
    clientName: string;
    openTasks: number;
    overdueTasks: number;
  }>;
  dueThisWeek: TaskDto[];
}

export interface DeveloperDashboard {
  variant: 'developer';
  totals: {
    assigned: number;
    openTasks: number;
    overdueTasks: number;
    dueThisWeek: number;
    completedThisWeek: number;
  };
  tasksByStatus: StatusCounts;
  /** Priority first (CRITICAL → LOW), then nearest deadline. */
  tasks: TaskDto[];
}

export type DashboardPayload = AdminDashboard | ManagerDashboard | DeveloperDashboard;

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ */

const adminDashboard = async (): Promise<AdminDashboard> => {
  const [
    projects,
    activeProjects,
    tasks,
    overdueCount,
    clients,
    users,
    byStatus,
    byPriority,
    overdueRows,
  ] = await Promise.all([
    prisma.project.count(),
    prisma.project.count({ where: { status: 'ACTIVE' } }),
    prisma.task.count(),
    prisma.task.count({ where: { isOverdue: true } }),
    prisma.client.count({ where: { isArchived: false } }),
    prisma.user.count({ where: { isActive: true } }),
    tasksByStatus({}),
    tasksByPriority({}),
    prisma.task.findMany({
      where: { isOverdue: true },
      orderBy: [{ priority: 'desc' }, { dueDate: { sort: 'asc', nulls: 'last' } }],
      take: 10,
      select: TASK_SELECT,
    }),
  ]);

  return {
    variant: 'admin',
    totals: { projects, activeProjects, tasks, overdueTasks: overdueCount, clients, users },
    tasksByStatus: byStatus,
    tasksByPriority: byPriority,
    presence: presenceSnapshot(),
    overdueTasks: overdueRows.map(toTaskDto),
  };
};

/* ------------------------------------------------------------------ *
 * Project manager
 * ------------------------------------------------------------------ */

const managerDashboard = async (principal: Principal): Promise<ManagerDashboard> => {
  const scopedProjects = projectScope(principal);
  const scopedTasks = taskScope(principal);
  const week = thisWeek();

  const [projectRows, projects, activeProjects, tasks, overdueTasks, awaitingReview, byStatus, byPriority, dueRows] =
    await Promise.all([
      prisma.project.findMany({
        where: scopedProjects,
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { updatedAt: 'desc' }],
        take: 20,
        select: {
          id: true,
          name: true,
          status: true,
          dueDate: true,
          client: { select: { name: true } },
          _count: { select: { tasks: true } },
        },
      }),
      prisma.project.count({ where: scopedProjects }),
      prisma.project.count({ where: { AND: [scopedProjects, { status: 'ACTIVE' }] } }),
      prisma.task.count({ where: scopedTasks }),
      prisma.task.count({ where: { AND: [scopedTasks, { isOverdue: true }] } }),
      prisma.task.count({ where: { AND: [scopedTasks, { status: TaskStatus.IN_REVIEW }] } }),
      tasksByStatus(scopedTasks),
      tasksByPriority(scopedTasks),
      prisma.task.findMany({
        where: {
          AND: [
            scopedTasks,
            { status: { not: TaskStatus.DONE } },
            { dueDate: { gte: week.from, lte: week.to } },
          ],
        },
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }],
        take: 15,
        select: TASK_SELECT,
      }),
    ]);

  // Per-project open and overdue counts in two grouped queries rather than one
  // pair per card.
  const ids = projectRows.map((row) => row.id);
  const [openGroups, overdueGroups] = await Promise.all([
    prisma.task.groupBy({
      by: ['projectId'],
      where: { projectId: { in: ids }, status: { not: TaskStatus.DONE } },
      _count: { _all: true },
    }),
    prisma.task.groupBy({
      by: ['projectId'],
      where: { projectId: { in: ids }, isOverdue: true },
      _count: { _all: true },
    }),
  ]);
  const openBy = new Map(openGroups.map((row) => [row.projectId, row._count._all]));
  const overdueBy = new Map(overdueGroups.map((row) => [row.projectId, row._count._all]));

  return {
    variant: 'manager',
    totals: { projects, activeProjects, tasks, overdueTasks, awaitingReview },
    tasksByStatus: byStatus,
    tasksByPriority: byPriority,
    projects: projectRows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      dueDate: row.dueDate?.toISOString() ?? null,
      clientName: row.client.name,
      openTasks: openBy.get(row.id) ?? 0,
      overdueTasks: overdueBy.get(row.id) ?? 0,
    })),
    dueThisWeek: dueRows.map(toTaskDto),
  };
};

/* ------------------------------------------------------------------ *
 * Developer
 * ------------------------------------------------------------------ */

const developerDashboard = async (principal: Principal): Promise<DeveloperDashboard> => {
  const scoped = taskScope(principal);
  const week = thisWeek();

  const [assigned, openTasks, overdueTasks, dueThisWeek, completedThisWeek, byStatus, rows] = await Promise.all([
    prisma.task.count({ where: scoped }),
    prisma.task.count({ where: { AND: [scoped, { status: { not: TaskStatus.DONE } }] } }),
    prisma.task.count({ where: { AND: [scoped, { isOverdue: true }] } }),
    prisma.task.count({
      where: {
        AND: [scoped, { status: { not: TaskStatus.DONE } }, { dueDate: { gte: week.from, lte: week.to } }],
      },
    }),
    prisma.task.count({
      where: {
        AND: [
          scoped,
          { status: TaskStatus.DONE },
          { completedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        ],
      },
    }),
    tasksByStatus(scoped),
    // The brief's exact ordering: priority, then due date. The `TaskPriority`
    // enum is declared LOW → CRITICAL and Postgres orders enums by declaration
    // order, so `desc` puts CRITICAL first without a CASE expression.
    prisma.task.findMany({
      where: { AND: [scoped, { status: { not: TaskStatus.DONE } }] },
      orderBy: [
        { priority: 'desc' },
        { dueDate: { sort: 'asc', nulls: 'last' } },
        { number: 'asc' },
      ],
      take: 50,
      select: TASK_SELECT,
    }),
  ]);

  return {
    variant: 'developer',
    totals: { assigned, openTasks, overdueTasks, dueThisWeek, completedThisWeek },
    tasksByStatus: byStatus,
    tasks: rows.map(toTaskDto),
  };
};

/** Dispatch on role — the caller never chooses which variant it gets. */
export const getDashboard = (principal: Principal): Promise<DashboardPayload> => {
  switch (principal.role) {
    case Role.ADMIN:
      return adminDashboard();
    case Role.PROJECT_MANAGER:
      return managerDashboard(principal);
    case Role.DEVELOPER:
      return developerDashboard(principal);
  }
};
