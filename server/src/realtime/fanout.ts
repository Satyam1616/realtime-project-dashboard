/**
 * Role-filtered real-time fanout.
 *
 * This is the heart of the live feed and the place where a mistake becomes a
 * data leak, so the rule is stated once and applied everywhere:
 *
 *   **An event is delivered to a socket only if that socket's principal would
 *   also have received the event from the REST API.**
 *
 * Two delivery strategies, chosen per event type:
 *
 *   1. *Addressed fanout* (`activity:new`, `notification:*`) — we compute the
 *      exact set of authorised recipients from the event itself and emit to
 *      their `user:<id>` rooms plus `role:ADMIN`. Socket.IO de-duplicates a
 *      socket that matches several rooms in one emit, so nobody gets doubles.
 *      Crucially the *server* decides who is eligible; there is no client-side
 *      filtering we depend on for correctness.
 *
 *   2. *Filtered room walk* (`task:changed`) — board updates are only
 *      interesting to people looking at that project, so we start from the
 *      `project:<id>` room. But room membership means "is viewing", not "is
 *      allowed to see", so we never `io.to(room).emit()`: we fetch the sockets
 *      and re-check each principal against the same visibility predicate the
 *      database uses. A developer viewing a project therefore sees their own
 *      card move and never a colleague's.
 */
import type { Server as IOServer, Socket } from 'socket.io';
import { Role } from '../db/client.js';
import type {
  ActivityEventDto,
  ClientToServerEvents,
  NotificationDto,
  PresenceDto,
  ServerToClientEvents,
  SocketData,
  TaskChangedDto,
} from './types.js';
import { roomForProject, roomForRole, roomForUser } from './types.js';

export type AppIOServer = IOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/**
 * Who, besides admins, is entitled to an event about this task/project.
 *
 * Mirrors `activityScope()` in src/access/rbac.ts:
 *   - the project manager who owns the project (their portfolio, their team)
 *   - the developer the task is assigned to (their work only)
 */
export interface EventAudience {
  projectManagerId: string;
  /** Null for project-level events, which developers are not entitled to. */
  assigneeId?: string | null;
  /** Included so the person who performed the action always sees the result. */
  actorId?: string | null;
}

const addressedRooms = (audience: EventAudience): string[] => {
  const rooms = new Set<string>([roomForRole(Role.ADMIN), roomForUser(audience.projectManagerId)]);
  if (audience.assigneeId) rooms.add(roomForUser(audience.assigneeId));
  // The actor already knows what they did; echoing keeps their own UI in sync
  // without a refetch, and can never reveal anything new to them.
  if (audience.actorId) rooms.add(roomForUser(audience.actorId));
  return [...rooms];
};

/** Delivers one activity entry to every principal whose role scope includes it. */
export const emitActivity = (io: AppIOServer, event: ActivityEventDto, audience: EventAudience): void => {
  const rooms = addressedRooms(audience);
  // A developer is only entitled to task-level events. `addressedRooms` already
  // omits them when `assigneeId` is null, so project-level events reach admins
  // and the owning PM only.
  io.to(rooms).emit('activity:new', event);
};

/**
 * The same visibility rule as `taskScope()`, evaluated against an in-memory
 * principal instead of compiled into SQL.
 *
 * Kept beside the SQL version deliberately: if these two ever disagree the feed
 * leaks, so they are covered by the same tests
 * (test/realtime.fanout.test.ts asserts parity with the REST scope).
 */
export const principalCanSeeTask = (
  data: SocketData,
  task: { projectManagerId: string; assigneeId: string | null },
): boolean => {
  switch (data.role) {
    case Role.ADMIN:
      return true;
    case Role.PROJECT_MANAGER:
      return task.projectManagerId === data.userId;
    case Role.DEVELOPER:
      return task.assigneeId === data.userId;
  }
};

/**
 * Board updates for people currently viewing the project, each re-authorised.
 *
 * `fetchSockets()` is used rather than a room broadcast precisely so the
 * per-principal check cannot be skipped.
 */
export const emitTaskChanged = async (
  io: AppIOServer,
  task: TaskChangedDto,
  audience: EventAudience,
): Promise<void> => {
  const viewers = await io.in(roomForProject(task.projectId)).fetchSockets();

  const delivered = new Set<string>();
  for (const socket of viewers) {
    const data = socket.data as SocketData;
    if (!data?.userId) continue;
    if (!principalCanSeeTask(data, { projectManagerId: audience.projectManagerId, assigneeId: task.assigneeId })) {
      continue;
    }
    socket.emit('task:changed', task);
    delivered.add(socket.id);
  }

  // The assignee and owning PM may have the task open in a list view rather
  // than the project board (dashboard, "my tasks"), so they are not in the
  // project room. Reach them directly, skipping anyone already served above.
  const directRooms = addressedRooms(audience);
  const direct = await io.in(directRooms).fetchSockets();
  for (const socket of direct) {
    if (delivered.has(socket.id)) continue;
    const data = socket.data as SocketData;
    if (!data?.userId) continue;
    if (!principalCanSeeTask(data, { projectManagerId: audience.projectManagerId, assigneeId: task.assigneeId })) {
      continue;
    }
    socket.emit('task:changed', task);
  }
};

/**
 * Tells one specific user that a task has left their view.
 *
 * Needed after a reassignment: the new `assigneeId` means the previous
 * assignee now fails `principalCanSeeTask`, so `emitTaskChanged` correctly
 * skips them — and their open board would keep a stale card until a refresh.
 * From their side the task genuinely is gone, so `deleted` is the honest
 * change kind. This discloses nothing: they already had access to the row.
 */
export const emitTaskRemoved = (io: AppIOServer, userId: string, task: TaskChangedDto): void => {
  io.to(roomForUser(userId)).emit('task:changed', { ...task, changeKind: 'deleted' });
};

/** Notifications are addressed to exactly one person. */
export const emitNotification = (
  io: AppIOServer,
  recipientId: string,
  notification: NotificationDto,
  unread: number,
): void => {
  io.to(roomForUser(recipientId)).emit('notification:new', notification);
  io.to(roomForUser(recipientId)).emit('notification:count', { unread });
};

/** Pushes the authoritative unread count after a read / read-all. */
export const emitUnreadCount = (io: AppIOServer, recipientId: string, unread: number): void => {
  io.to(roomForUser(recipientId)).emit('notification:count', { unread });
};

/** The presence tile is an admin-only dashboard metric. */
export const emitPresence = (io: AppIOServer, presence: PresenceDto): void => {
  io.to(roomForRole(Role.ADMIN)).emit('presence:update', presence);
};

/**
 * Force-disconnects every socket belonging to a user.
 *
 * A long-lived socket authenticated 20 minutes ago would otherwise keep
 * streaming events after the account was deactivated or its sessions revoked,
 * because the handshake check does not re-run on a live connection.
 */
export const revokeUserSockets = async (io: AppIOServer, userId: string, reason: string): Promise<void> => {
  const sockets = await io.in(roomForUser(userId)).fetchSockets();
  for (const socket of sockets) {
    socket.emit('session:revoked', { reason });
    socket.disconnect(true);
  }
};

export type { AppSocket };
