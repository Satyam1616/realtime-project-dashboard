/**
 * Clients.
 *
 * Admins own this list; project managers may read it because they have to
 * attach a project to a client, and nothing more. That split is the whole of
 * the authorisation story — but the *contents* of a read still need scoping:
 *
 *   the project count shown next to each client is computed through
 *   `projectScope(principal)`, so a manager sees "2 projects" for the two they
 *   run, not "9" including seven they cannot open. A global count would leak the
 *   size of other managers' portfolios through an endpoint that is otherwise
 *   safe for them to read.
 *
 * Clients are archived, not deleted. `Project.clientId` is `onDelete: Restrict`,
 * so a hard delete is only offered for a client that never had a project;
 * anything else would either fail at the database or destroy history.
 */
import { prisma, Prisma } from '../../db/client.js';
import { canManageClients, canReadClients, projectScope, type Principal } from '../../access/rbac.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import type { CreateClientInput, ListClientsQuery, UpdateClientInput } from './clients.schemas.js';

const CLIENT_SELECT = {
  id: true,
  name: true,
  company: true,
  contactName: true,
  contactEmail: true,
  isArchived: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ClientRow = Prisma.ClientGetPayload<{ select: typeof CLIENT_SELECT }>;

export interface ClientDto {
  id: string;
  name: string;
  company: string | null;
  contactName: string | null;
  contactEmail: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Projects **this principal can see** for the client — see the file header. */
  projectCount: number;
  /** Projects in total, admin-only; managers get `null`. */
  totalProjectCount: number | null;
}

const assertCanRead = (principal: Principal): void => {
  if (!canReadClients(principal)) {
    throw forbidden('You do not have access to the client list.');
  }
};

const assertCanManage = (principal: Principal): void => {
  if (!canManageClients(principal)) {
    throw forbidden('Only an admin can manage clients.');
  }
};

/**
 * Visible-project counts for a page of clients, in one grouped query rather
 * than one count per row.
 */
const projectCountsFor = async (
  principal: Principal,
  clientIds: string[],
): Promise<{ visible: Map<string, number>; total: Map<string, number> | null }> => {
  if (clientIds.length === 0) return { visible: new Map(), total: null };

  const scope = projectScope(principal);
  const isAdminView = Object.keys(scope).length === 0;

  const visibleGroups = await prisma.project.groupBy({
    by: ['clientId'],
    where: { AND: [scope, { clientId: { in: clientIds } }] },
    _count: { _all: true },
  });
  const visible = new Map(visibleGroups.map((row) => [row.clientId, row._count._all]));

  // For an admin the scope is empty, so the visible count *is* the total —
  // no second query, and no total exposed to anyone else.
  return { visible, total: isAdminView ? visible : null };
};

const toDto = (row: ClientRow, visible: number, total: number | null): ClientDto => ({
  id: row.id,
  name: row.name,
  company: row.company,
  contactName: row.contactName,
  contactEmail: row.contactEmail,
  isArchived: row.isArchived,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  projectCount: visible,
  totalProjectCount: total,
});

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export const listClients = async (
  principal: Principal,
  query: ListClientsQuery,
): Promise<{ items: ClientDto[]; total: number }> => {
  assertCanRead(principal);

  const filters: Prisma.ClientWhereInput[] = [];
  if (!query.includeArchived) filters.push({ isArchived: false });
  if (query.q) {
    filters.push({
      OR: [
        { name: { contains: query.q, mode: 'insensitive' } },
        { company: { contains: query.q, mode: 'insensitive' } },
        { contactName: { contains: query.q, mode: 'insensitive' } },
      ],
    });
  }

  const where: Prisma.ClientWhereInput = filters.length > 0 ? { AND: filters } : {};

  const [rows, total] = await Promise.all([
    // Matches the `@@index([isArchived, name])` declared on the model.
    prisma.client.findMany({
      where,
      select: CLIENT_SELECT,
      orderBy: [{ name: 'asc' }],
      take: query.limit,
      skip: query.offset,
    }),
    prisma.client.count({ where }),
  ]);

  const counts = await projectCountsFor(
    principal,
    rows.map((row) => row.id),
  );

  return {
    items: rows.map((row) =>
      toDto(row, counts.visible.get(row.id) ?? 0, counts.total ? (counts.total.get(row.id) ?? 0) : null),
    ),
    total,
  };
};

export const getClient = async (principal: Principal, id: string): Promise<ClientDto> => {
  assertCanRead(principal);

  const row = await prisma.client.findUnique({ where: { id }, select: CLIENT_SELECT });
  if (!row) throw notFound('Client');

  const counts = await projectCountsFor(principal, [id]);
  return toDto(row, counts.visible.get(id) ?? 0, counts.total ? (counts.total.get(id) ?? 0) : null);
};

/* ------------------------------------------------------------------ *
 * Writes — admin only
 * ------------------------------------------------------------------ */

export const createClient = async (principal: Principal, input: CreateClientInput): Promise<ClientDto> => {
  assertCanManage(principal);

  const created = await prisma.client.create({
    data: {
      name: input.name,
      company: input.company ?? null,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
    },
    select: CLIENT_SELECT,
  });

  return toDto(created, 0, 0);
};

export const updateClient = async (
  principal: Principal,
  id: string,
  patch: UpdateClientInput,
): Promise<ClientDto> => {
  assertCanManage(principal);

  const existing = await prisma.client.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('Client');

  const data: Prisma.ClientUpdateInput = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.company !== undefined ? { company: patch.company } : {}),
    ...(patch.contactName !== undefined ? { contactName: patch.contactName } : {}),
    ...(patch.contactEmail !== undefined ? { contactEmail: patch.contactEmail } : {}),
    ...(patch.isArchived !== undefined ? { isArchived: patch.isArchived } : {}),
  };

  // Archiving a client with live work in flight is almost always a mistake, and
  // the project list would silently keep referencing an archived client.
  if (patch.isArchived === true) {
    const liveProjects = await prisma.project.count({
      where: { clientId: id, status: { in: ['ACTIVE', 'ON_HOLD'] } },
    });
    if (liveProjects > 0) {
      throw conflict(
        `This client still has ${liveProjects} active project(s). Complete or archive them first.`,
      );
    }
  }

  const updated = await prisma.client.update({ where: { id }, data, select: CLIENT_SELECT });
  const counts = await projectCountsFor(principal, [id]);
  return toDto(updated, counts.visible.get(id) ?? 0, counts.total ? (counts.total.get(id) ?? 0) : null);
};

/**
 * Hard delete, permitted only while the client has no projects.
 *
 * `Project.clientId` is `onDelete: Restrict`, so the alternative to this check
 * is a foreign-key error surfacing as a 500. Checking first turns it into an
 * actionable 409 that names archiving as the way forward.
 */
export const deleteClient = async (principal: Principal, id: string): Promise<void> => {
  assertCanManage(principal);

  const existing = await prisma.client.findUnique({
    where: { id },
    select: { id: true, _count: { select: { projects: true } } },
  });
  if (!existing) throw notFound('Client');

  if (existing._count.projects > 0) {
    throw conflict('This client has projects and cannot be deleted. Archive it instead.');
  }

  await prisma.client.delete({ where: { id } });
};
