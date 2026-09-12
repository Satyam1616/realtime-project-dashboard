/**
 * In-app notifications.
 *
 * Notifications are persisted first and pushed second: the row is the record,
 * the WebSocket message is only a delivery optimisation. That ordering is what
 * makes the badge correct for a user who was offline when the event happened —
 * they get the count from the database on their next connect, and the socket
 * keeps it live from then on. Nothing polls.
 */
import { prisma, Prisma, type NotificationType } from '../../db/client.js';
import { notificationScope, type Principal } from '../../access/rbac.js';
import { getIO } from '../../realtime/socket.server.js';
import { emitNotification, emitUnreadCount } from '../../realtime/fanout.js';
import type { NotificationDto } from '../../realtime/types.js';
import { notFound } from '../../lib/errors.js';

type Db = Prisma.TransactionClient | typeof prisma;

const NOTIFICATION_SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  taskId: true,
  projectId: true,
  readAt: true,
  createdAt: true,
  actor: { select: { name: true } },
} as const;

type NotificationRow = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  taskId: string | null;
  projectId: string | null;
  readAt: Date | null;
  createdAt: Date;
  actor: { name: string } | null;
};

export const toNotificationDto = (row: NotificationRow): NotificationDto => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.body,
  taskId: row.taskId,
  projectId: row.projectId,
  actorName: row.actor?.name ?? null,
  readAt: row.readAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export interface CreateNotificationInput {
  recipientId: string;
  actorId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  taskId?: string | null;
  projectId?: string | null;
}

/**
 * Queues a notification inside the caller's transaction.
 *
 * Self-notifications are dropped: a developer who moves their own task to In
 * Review should not be told about it, and a PM who assigns a task to themselves
 * does not need a badge for their own action.
 */
export const createNotification = async (db: Db, input: CreateNotificationInput): Promise<string | null> => {
  if (input.actorId && input.actorId === input.recipientId) return null;

  const created = await db.notification.create({
    data: {
      recipientId: input.recipientId,
      actorId: input.actorId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
    },
    select: { id: true },
  });

  return created.id;
};

export const unreadCount = (userId: string): Promise<number> =>
  prisma.notification.count({ where: { recipientId: userId, readAt: null } });

/**
 * Pushes a committed notification to its recipient, together with the
 * authoritative unread count so the badge never drifts from the database.
 *
 * Called *after* the transaction commits. Safe to call with ids that no longer
 * exist (the row is re-read), and a no-op without a live socket server.
 */
export const publishNotifications = async (notificationIds: Array<string | null>): Promise<void> => {
  const ids = notificationIds.filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return;

  const io = getIO();
  if (!io) return;

  const rows = await prisma.notification.findMany({
    where: { id: { in: ids } },
    select: { ...NOTIFICATION_SELECT, recipientId: true },
  });

  // One count query per distinct recipient rather than per notification.
  const recipients = [...new Set(rows.map((row) => row.recipientId))];
  const counts = new Map(
    await Promise.all(recipients.map(async (id) => [id, await unreadCount(id)] as const)),
  );

  for (const row of rows) {
    emitNotification(io, row.recipientId, toNotificationDto(row), counts.get(row.recipientId) ?? 0);
  }
};

/* ------------------------------------------------------------------ *
 * Reads and state changes
 * ------------------------------------------------------------------ */

export interface ListNotificationsOptions {
  limit: number;
  cursor?: string;
  unreadOnly?: boolean;
}

export interface NotificationPage {
  items: NotificationDto[];
  nextCursor: string | null;
  unread: number;
}

export const listNotifications = async (
  principal: Principal,
  options: ListNotificationsOptions,
): Promise<NotificationPage> => {
  const where: Prisma.NotificationWhereInput = {
    AND: [
      notificationScope(principal),
      ...(options.unreadOnly ? [{ readAt: null }] : []),
      ...(options.cursor ? [{ createdAt: { lt: new Date(options.cursor) } }] : []),
    ],
  };

  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: options.limit + 1,
      select: NOTIFICATION_SELECT,
    }),
    unreadCount(principal.id),
  ]);

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    items: page.map(toNotificationDto),
    nextCursor: hasMore ? page[page.length - 1]!.createdAt.toISOString() : null,
    unread,
  };
};

/**
 * Marks one notification read.
 *
 * Scoped by recipient in the `updateMany` filter rather than checked after a
 * fetch, so one user cannot mark another user's notification read — and gets a
 * 404 rather than a 403, which avoids confirming that the id exists.
 */
export const markNotificationRead = async (principal: Principal, id: string): Promise<number> => {
  const { count } = await prisma.notification.updateMany({
    where: { id, recipientId: principal.id, readAt: null },
    data: { readAt: new Date() },
  });

  if (count === 0) {
    // Either it does not exist, belongs to someone else, or was already read.
    // Distinguish the last case so re-clicking a read notification is not an error.
    const exists = await prisma.notification.findFirst({
      where: { id, recipientId: principal.id },
      select: { id: true },
    });
    if (!exists) throw notFound('Notification');
  }

  const unread = await unreadCount(principal.id);
  const io = getIO();
  if (io) emitUnreadCount(io, principal.id, unread);
  return unread;
};

export const markAllNotificationsRead = async (principal: Principal): Promise<number> => {
  await prisma.notification.updateMany({
    where: { recipientId: principal.id, readAt: null },
    data: { readAt: new Date() },
  });

  const io = getIO();
  if (io) emitUnreadCount(io, principal.id, 0);
  return 0;
};
