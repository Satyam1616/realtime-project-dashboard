/**
 * The WebSocket contract.
 *
 * Event names and payload shapes live in one file so the fanout code and the
 * client stay in step. The browser mirrors these declarations in
 * `web/src/types/realtime.ts` (see "Known limitations" in README.md — this
 * should eventually be a shared workspace package).
 *
 * Naming convention: `domain:event`, past tense for things that happened.
 */
import type { ActivityType, Role, TaskPriority, TaskStatus } from '../db/client.js';

/* ------------------------------------------------------------------ *
 * Payloads
 * ------------------------------------------------------------------ */

/**
 * One activity-feed entry. This is the *same* shape the REST catch-up endpoint
 * returns, so the client has a single renderer for live and replayed events and
 * cannot drift between them.
 */
export interface ActivityEventDto {
  id: string;
  /** Monotonic sequence — the client's high-water mark for catch-up. */
  seq: number;
  type: ActivityType;
  projectId: string;
  projectName: string;
  taskId: string | null;
  taskNumber: number | null;
  taskTitle: string | null;
  actorId: string | null;
  actorName: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** Emitted when a task's fields change, so an open board can move the card. */
export interface TaskChangedDto {
  id: string;
  number: number;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  isOverdue: boolean;
  projectId: string;
  assigneeId: string | null;
  assigneeName: string | null;
  updatedAt: string;
  /** What kind of change this was, for optimistic-update reconciliation. */
  changeKind: 'created' | 'updated' | 'status' | 'assignment' | 'deleted';
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

/** Admin dashboard presence tile. */
export interface PresenceDto {
  onlineCount: number;
  users: Array<{ id: string; name: string; role: Role; avatarColor: string }>;
}

/* ------------------------------------------------------------------ *
 * Server -> client
 * ------------------------------------------------------------------ */

export interface ServerToClientEvents {
  /** A new, already role-filtered activity entry. */
  'activity:new': (event: ActivityEventDto) => void;
  /** Task state changed inside a project the socket is currently viewing. */
  'task:changed': (task: TaskChangedDto) => void;
  /** A new in-app notification for this user. */
  'notification:new': (notification: NotificationDto) => void;
  /** Authoritative unread count. Pushed, never polled. */
  'notification:count': (payload: { unread: number }) => void;
  /** Live count of distinct signed-in users (admins only). */
  'presence:update': (payload: PresenceDto) => void;
  /** The server is closing this socket — e.g. the account was deactivated. */
  'session:revoked': (payload: { reason: string }) => void;
}

/* ------------------------------------------------------------------ *
 * Client -> server
 * ------------------------------------------------------------------ */

export interface ClientToServerEvents {
  /**
   * "I am looking at this project." The server authorises the subscription
   * against the caller's project scope before joining the room — a client
   * cannot subscribe its way into data its role cannot see.
   */
  'project:subscribe': (
    payload: { projectId: string },
    ack?: (result: { ok: boolean; error?: string }) => void,
  ) => void;
  'project:unsubscribe': (payload: { projectId: string }) => void;
  /**
   * Acknowledge activity up to `seq`, persisting the high-water mark used by
   * `GET /api/activity/catchup`.
   */
  'activity:seen': (payload: { seq: number }) => void;
}

/** Per-socket server state. */
export interface SocketData {
  userId: string;
  email: string;
  name: string;
  role: Role;
  avatarColor: string;
}

/* ------------------------------------------------------------------ *
 * Room naming
 * ------------------------------------------------------------------ */

/**
 * Rooms are the fanout primitive:
 *
 *   user:<id>     every socket of one person — the unit of role-filtered delivery
 *   role:ADMIN    all admins, for the global feed and presence tile
 *   project:<id>  people *currently viewing* a project, for board updates
 *
 * Note that `project:<id>` is never broadcast to blindly: membership of that
 * room means "is looking at this project", not "is allowed to see every task in
 * it". See `fanout.ts`.
 */
export const roomForUser = (userId: string): string => `user:${userId}`;
export const roomForRole = (role: Role): string => `role:${role}`;
export const roomForProject = (projectId: string): string => `project:${projectId}`;
