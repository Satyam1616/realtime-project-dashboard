/**
 * The WebSocket contract, mirrored from `server/src/realtime/types.ts`.
 *
 * Kept as a hand-written mirror rather than an import: the server module pulls
 * its enums from the generated Prisma client, which has no business in a
 * browser bundle. The server file names this one explicitly, so a change there
 * has an obvious second home. See "Known limitations" in README.md.
 */
import type { Role, TaskPriority, TaskStatus } from './api';

export type ActivityType =
  | 'PROJECT_CREATED'
  | 'PROJECT_UPDATED'
  | 'PROJECT_MEMBER_ADDED'
  | 'PROJECT_MEMBER_REMOVED'
  | 'TASK_CREATED'
  | 'TASK_STATUS_CHANGED'
  | 'TASK_ASSIGNED'
  | 'TASK_UNASSIGNED'
  | 'TASK_PRIORITY_CHANGED'
  | 'TASK_DUE_DATE_CHANGED'
  | 'TASK_UPDATED'
  | 'TASK_OVERDUE'
  | 'TASK_DELETED';

/**
 * One activity-feed entry — identical to what `GET /api/activity` returns, so
 * live events and replayed history share a single renderer and cannot drift.
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
  changeKind: 'created' | 'updated' | 'status' | 'assignment' | 'deleted';
}

export interface RealtimeNotificationDto {
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

export interface PresenceDto {
  onlineCount: number;
  users: Array<{ id: string; name: string; role: Role; avatarColor: string }>;
}

export interface ServerToClientEvents {
  'activity:new': (event: ActivityEventDto) => void;
  'task:changed': (task: TaskChangedDto) => void;
  'notification:new': (notification: RealtimeNotificationDto) => void;
  'notification:count': (payload: { unread: number }) => void;
  'presence:update': (payload: PresenceDto) => void;
  'session:revoked': (payload: { reason: string }) => void;
}

export interface ClientToServerEvents {
  'project:subscribe': (
    payload: { projectId: string },
    ack?: (result: { ok: boolean; error?: string }) => void,
  ) => void;
  'project:unsubscribe': (payload: { projectId: string }) => void;
  'activity:seen': (payload: { seq: number }) => void;
}

export interface CatchupResponse {
  events: ActivityEventDto[];
  missedCount: number;
  latestSeq: number;
  lastSeenSeq: number;
}
