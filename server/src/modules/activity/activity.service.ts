/**
 * Activity feed: durable writes, role-scoped reads, and missed-event catch-up.
 *
 * Three properties this module exists to guarantee:
 *
 *   1. **The log is the source of truth.** Every entry is a row written in the
 *      same transaction as the change it describes. Nothing about the feed is
 *      derived from current task state, so the history of a task survives the
 *      task being renamed, reassigned or deleted.
 *
 *   2. **Nothing is broadcast before it is committed.** `recordActivity` runs
 *      inside the caller's transaction and returns a payload; `publishActivity`
 *      pushes it over WebSocket *after* the transaction commits. Emitting
 *      inside the transaction would let clients render a change that then rolled
 *      back — and because the feed is append-only, there would be no correcting
 *      event to undo it.
 *
 *   3. **Catch-up comes from Postgres, not memory.** A reconnecting client is
 *      served from the `seq` sequence and its persisted `ActivityCursor`
 *      high-water mark, so it works across a server restart and across
 *      instances.
 */
import { prisma, Prisma, type ActivityType, type TaskStatus } from '../../db/client.js';
import { activityScope, type Principal } from '../../access/rbac.js';
import { getIO } from '../../realtime/socket.server.js';
import { emitActivity, type EventAudience } from '../../realtime/fanout.js';
import type { ActivityEventDto } from '../../realtime/types.js';

/** Anything that can run a query: the base client or a transaction handle. */
type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Columns needed to render a feed entry. Because the presentation fields are
 * denormalised onto the event row, rendering needs **no joins** — which is what
 * keeps the global admin feed cheap.
 */
const FEED_SELECT = {
  id: true,
  seq: true,
  type: true,
  projectId: true,
  projectName: true,
  taskId: true,
  taskNumber: true,
  taskTitle: true,
  actorId: true,
  actorName: true,
  fromStatus: true,
  toStatus: true,
  metadata: true,
  createdAt: true,
} as const;

type FeedRow = {
  id: string;
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
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
};

export const toActivityDto = (row: FeedRow): ActivityEventDto => ({
  id: row.id,
  seq: row.seq,
  type: row.type,
  projectId: row.projectId,
  projectName: row.projectName,
  taskId: row.taskId,
  taskNumber: row.taskNumber,
  taskTitle: row.taskTitle,
  actorId: row.actorId,
  actorName: row.actorName,
  fromStatus: row.fromStatus,
  toStatus: row.toStatus,
  metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  createdAt: row.createdAt.toISOString(),
});

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export interface RecordActivityInput {
  type: ActivityType;
  projectId: string;
  projectName: string;
  /** Null for events raised by the scheduler rather than a person. */
  actorId: string | null;
  /** Denormalised so the feed still reads correctly if the actor is deleted. */
  actorName: string;
  taskId?: string | null;
  taskNumber?: number | null;
  taskTitle?: string | null;
  fromStatus?: TaskStatus | null;
  toStatus?: TaskStatus | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Appends one event. Call this with the transaction handle of the write it
 * describes — see `tasks.service.ts` for the pattern.
 */
export const recordActivity = async (db: Db, input: RecordActivityInput): Promise<ActivityEventDto> => {
  const row = await db.activityEvent.create({
    data: {
      type: input.type,
      projectId: input.projectId,
      projectName: input.projectName,
      actorId: input.actorId,
      actorName: input.actorName,
      taskId: input.taskId ?? null,
      taskNumber: input.taskNumber ?? null,
      taskTitle: input.taskTitle ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    select: FEED_SELECT,
  });

  return toActivityDto(row);
};

/**
 * Broadcast an already-committed event to everyone whose role scope includes it.
 *
 * A no-op when the socket server is not running (tests, one-off scripts), which
 * keeps the service layer usable without a live server.
 */
export const publishActivity = (event: ActivityEventDto, audience: EventAudience): void => {
  const io = getIO();
  if (!io) return;
  emitActivity(io, event, audience);
};

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export interface ListActivityOptions {
  limit: number;
  /** Exclusive upper bound on `seq`, for newest-first infinite scroll. */
  cursor?: number;
  /** Narrow the (already role-scoped) feed to one project. */
  projectId?: string;
}

export interface ActivityPage {
  items: ActivityEventDto[];
  nextCursor: string | null;
}

/**
 * The role-scoped feed, newest first.
 *
 * `activityScope()` is AND-ed in, so an admin gets the global feed, a PM gets
 * only their own projects, and a developer gets only events on tasks assigned to
 * them — enforced in SQL, identically to every other read in the app.
 */
export const listActivity = async (principal: Principal, options: ListActivityOptions): Promise<ActivityPage> => {
  const where: Prisma.ActivityEventWhereInput = {
    AND: [
      activityScope(principal),
      ...(options.cursor !== undefined ? [{ seq: { lt: options.cursor } }] : []),
      ...(options.projectId ? [{ projectId: options.projectId }] : []),
    ],
  };

  // Fetch one extra row to determine whether another page exists without a
  // second COUNT query.
  const rows = await prisma.activityEvent.findMany({
    where,
    orderBy: { seq: 'desc' },
    take: options.limit + 1,
    select: FEED_SELECT,
  });

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    items: page.map(toActivityDto),
    nextCursor: hasMore ? String(page[page.length - 1]!.seq) : null,
  };
};

export interface CatchUpResult {
  /** Up to `limit` missed events, oldest-first so the client can append in order. */
  events: ActivityEventDto[];
  /** Total missed within scope — may exceed `events.length`. */
  missedCount: number;
  /** Head of the feed within this user's scope; 0 when they have no visible events. */
  latestSeq: number;
  lastSeenSeq: number;
}

/**
 * "What did I miss while I was gone?"
 *
 * Answered entirely from the database: the user's persisted `lastSeenSeq`
 * versus the `ActivityEvent` sequence, intersected with their role scope. No
 * in-memory buffer is consulted, so this is correct after a deploy, a crash, or
 * a week offline.
 */
export const catchUpActivity = async (principal: Principal, limit = 20): Promise<CatchUpResult> => {
  const scope = activityScope(principal);

  const cursor = await prisma.activityCursor.findUnique({
    where: { userId: principal.id },
    select: { lastSeenSeq: true },
  });
  const lastSeenSeq = cursor?.lastSeenSeq ?? 0;

  const missedWhere: Prisma.ActivityEventWhereInput = { AND: [scope, { seq: { gt: lastSeenSeq } }] };

  const [missedCount, newest, head] = await Promise.all([
    prisma.activityEvent.count({ where: missedWhere }),
    // Take the *most recent* `limit` missed events, then flip to chronological
    // order for display. Taking the oldest 20 would strand a long-absent user
    // on stale entries.
    prisma.activityEvent.findMany({
      where: missedWhere,
      orderBy: { seq: 'desc' },
      take: limit,
      select: FEED_SELECT,
    }),
    prisma.activityEvent.findFirst({ where: scope, orderBy: { seq: 'desc' }, select: { seq: true } }),
  ]);

  return {
    events: newest.reverse().map(toActivityDto),
    missedCount,
    latestSeq: head?.seq ?? 0,
    lastSeenSeq,
  };
};

/**
 * Move the user's high-water mark forward. Monotonic by construction: a
 * conditional `updateMany` means a late or out-of-order acknowledgement can
 * never rewind the cursor and re-show events the user has already read.
 */
export const advanceActivityCursor = async (userId: string, seq: number): Promise<void> => {
  const { count } = await prisma.activityCursor.updateMany({
    where: { userId, lastSeenSeq: { lt: seq } },
    data: { lastSeenSeq: seq },
  });

  if (count === 0) {
    // Either no cursor row yet, or it is already at/ahead of `seq`.
    // `skipDuplicates` makes the first case safe under concurrent acks.
    await prisma.activityCursor.createMany({
      data: [{ userId, lastSeenSeq: seq }],
      skipDuplicates: true,
    });
  }
};

/** Per-task history, role-scoped through the shared activity scope. */
export const listTaskActivity = async (principal: Principal, taskId: string): Promise<ActivityEventDto[]> => {
  const rows = await prisma.activityEvent.findMany({
    where: { AND: [activityScope(principal), { taskId }] },
    orderBy: { seq: 'desc' },
    take: 100,
    select: FEED_SELECT,
  });
  return rows.map(toActivityDto);
};
