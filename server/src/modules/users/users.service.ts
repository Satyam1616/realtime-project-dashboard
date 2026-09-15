/**
 * User administration.
 *
 * Two audiences, two levels of detail, and the difference matters:
 *
 *   - `listUsers` is admin-only and returns account state (role, active flag,
 *     email, last activity).
 *   - `listAssignableUsers` is open to project managers as well, because they
 *     have to pick somebody when assigning a task — but it returns only the
 *     people who can actually hold a task and only the fields needed to render
 *     a picker. A PM has no route to the full account list.
 *
 * Two changes here have consequences beyond the row being written, and both are
 * handled rather than left to expire on their own:
 *
 *   - **Deactivating** an account revokes its refresh-token families and
 *     force-disconnects its live sockets. Without the socket step a user
 *     disabled mid-session would keep streaming the activity feed until their
 *     connection happened to drop.
 *   - **Changing a role** does the same. Request authorisation re-reads the role
 *     from the database every time, so REST is already safe — but a socket
 *     captures its principal at handshake, so a demoted manager would keep a
 *     manager's fanout until reconnect.
 */
import { prisma, Prisma, Role } from '../../db/client.js';
import { canManageUsers, type Principal } from '../../access/rbac.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { pickAvatarColor } from '../../lib/avatar.js';
import { hashPassword } from '../../lib/password.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import type { AssignableQuery, CreateUserInput, ListUsersQuery, UpdateUserInput } from './users.schemas.js';

const ADMIN_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  avatarColor: true,
  jobTitle: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PICKER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  avatarColor: true,
  jobTitle: true,
} as const;

export interface AdminUserDto {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarColor: string;
  jobTitle: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Counts that make "can I safely deactivate this person?" answerable. */
  openTasks: number;
  managedProjects: number;
}

export interface AssignableUserDto {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarColor: string;
  jobTitle: string | null;
}

const assertAdmin = (principal: Principal): void => {
  if (!canManageUsers(principal)) {
    throw forbidden('Only an admin can manage user accounts.');
  }
};

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export const listUsers = async (
  principal: Principal,
  query: ListUsersQuery,
): Promise<{ items: AdminUserDto[]; total: number }> => {
  assertAdmin(principal);

  const filters: Prisma.UserWhereInput[] = [];
  if (query.role) filters.push({ role: query.role });
  if (!query.includeInactive) filters.push({ isActive: true });
  if (query.q) {
    filters.push({
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { email: { contains: query.q, mode: 'insensitive' } },
        { jobTitle: { contains: query.q, mode: 'insensitive' } },
      ],
    });
  }

  const where: Prisma.UserWhereInput = filters.length > 0 ? { AND: filters } : {};

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        ...ADMIN_SELECT,
        _count: { select: { managedProjects: true } },
        assignedTasks: { where: { status: { not: 'DONE' } }, select: { id: true } },
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      take: query.limit,
      skip: query.offset,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      avatarColor: row.avatarColor,
      jobTitle: row.jobTitle,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      openTasks: row.assignedTasks.length,
      managedProjects: row._count.managedProjects,
    })),
    total,
  };
};

/**
 * People a task can be given to.
 *
 * Admins are excluded because they operate the system rather than deliver the
 * work — the same rule `resolveAssignee` enforces on write, so the picker can
 * never offer a choice the API would reject.
 */
export const listAssignableUsers = async (
  principal: Principal,
  query: AssignableQuery,
): Promise<AssignableUserDto[]> => {
  if (principal.role === Role.DEVELOPER) {
    // A developer never assigns anything, and handing them a roster of
    // colleagues serves no feature in their UI.
    throw forbidden('Only admins and project managers can browse assignable users.');
  }

  const filters: Prisma.UserWhereInput[] = [{ isActive: true }, { role: { not: Role.ADMIN } }];
  if (query.projectId) {
    filters.push({
      OR: [
        { memberships: { some: { projectId: query.projectId } } },
        { assignedTasks: { some: { projectId: query.projectId } } },
      ],
    });
  }

  const rows = await prisma.user.findMany({
    where: { AND: filters },
    select: PICKER_SELECT,
    orderBy: [{ role: 'desc' }, { name: 'asc' }],
  });

  return rows;
};

export const getUser = async (principal: Principal, id: string): Promise<AdminUserDto> => {
  assertAdmin(principal);

  const row = await prisma.user.findUnique({
    where: { id },
    select: {
      ...ADMIN_SELECT,
      _count: { select: { managedProjects: true } },
      assignedTasks: { where: { status: { not: 'DONE' } }, select: { id: true } },
    },
  });
  if (!row) throw notFound('User');

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    avatarColor: row.avatarColor,
    jobTitle: row.jobTitle,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    openTasks: row.assignedTasks.length,
    managedProjects: row._count.managedProjects,
  };
};

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export const createUser = async (principal: Principal, input: CreateUserInput): Promise<AdminUserDto> => {
  assertAdmin(principal);

  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw conflict('An account with that email address already exists.');

  const created = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      jobTitle: input.jobTitle ?? null,
      avatarColor: input.avatarColor ?? pickAvatarColor(input.email),
    },
    select: ADMIN_SELECT,
  });

  return {
    ...created,
    createdAt: created.createdAt.toISOString(),
    updatedAt: created.updatedAt.toISOString(),
    openTasks: 0,
    managedProjects: 0,
  };
};

export const updateUser = async (
  principal: Principal,
  id: string,
  patch: UpdateUserInput,
): Promise<AdminUserDto> => {
  assertAdmin(principal);

  const existing = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, isActive: true },
  });
  if (!existing) throw notFound('User');

  // Guard rails against an admin locking themselves out of the system.
  if (existing.id === principal.id) {
    if (patch.isActive === false) throw badRequest('You cannot deactivate your own account.');
    if (patch.role && patch.role !== Role.ADMIN) throw badRequest('You cannot change your own role.');
  }

  // The last remaining admin must keep their access, or nobody can administer
  // the system again without a database edit.
  if (existing.role === Role.ADMIN && (patch.isActive === false || (patch.role && patch.role !== Role.ADMIN))) {
    const otherAdmins = await prisma.user.count({
      where: { role: Role.ADMIN, isActive: true, id: { not: existing.id } },
    });
    if (otherAdmins === 0) throw badRequest('This is the last active admin; promote another before changing it.');
  }

  const data: Prisma.UserUpdateInput = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.role !== undefined ? { role: patch.role } : {}),
    ...(patch.jobTitle !== undefined ? { jobTitle: patch.jobTitle } : {}),
    ...(patch.avatarColor !== undefined ? { avatarColor: patch.avatarColor } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    ...(patch.password !== undefined ? { passwordHash: await hashPassword(patch.password) } : {}),
  };

  const updated = await prisma.user.update({ where: { id }, data, select: ADMIN_SELECT });

  // Anything that changes what this account may do, or whether it may act at
  // all, must reach connections that are already open.
  const roleChanged = patch.role !== undefined && patch.role !== existing.role;
  const deactivated = patch.isActive === false && existing.isActive;
  const passwordReset = patch.password !== undefined;

  if (roleChanged || deactivated || passwordReset) {
    const reason = deactivated
      ? 'Your account has been deactivated.'
      : roleChanged
        ? 'Your role changed — please sign in again.'
        : 'Your password was reset — please sign in again.';
    await revokeAllSessions(id, reason);
  }

  const counts = await prisma.user.findUnique({
    where: { id },
    select: {
      _count: { select: { managedProjects: true } },
      assignedTasks: { where: { status: { not: 'DONE' } }, select: { id: true } },
    },
  });

  return {
    ...updated,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
    openTasks: counts?.assignedTasks.length ?? 0,
    managedProjects: counts?._count.managedProjects ?? 0,
  };
};
