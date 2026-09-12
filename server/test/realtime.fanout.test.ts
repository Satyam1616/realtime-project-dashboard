/**
 * Parity tests for the real-time fanout in src/realtime/fanout.ts.
 *
 * The fanout re-implements the visibility rule in memory, against a socket's
 * `SocketData`, because at emit time there is no query to AND a Prisma filter
 * into. Two implementations of one rule is a standing risk: if they drift, the
 * live feed shows a user something the REST API would have withheld, and that
 * is a data leak rather than a cosmetic bug.
 *
 * So the first block below asserts *parity* — for every (role, task) pair, the
 * socket-side predicate agrees with the database-side scope. `taskScope`
 * produces a Prisma fragment, not a predicate, so it is interpreted here by a
 * small evaluator: the point is to derive the expectation from the real scope
 * function rather than restate it, so that editing `rbac.ts` alone breaks this
 * test.
 *
 * The second block covers the addressed-fanout room maths, and the third uses
 * a fake Socket.IO server to prove `emitTaskChanged` re-authorises each viewer
 * instead of trusting room membership.
 */
import { describe, expect, it } from 'vitest';
import { Role } from '../src/db/client.js';
import { taskScope, type Principal } from '../src/access/rbac.js';
import {
  emitTaskChanged,
  emitTaskRemoved,
  principalCanSeeTask,
  type AppIOServer,
} from '../src/realtime/fanout.js';
import {
  roomForProject,
  roomForRole,
  roomForUser,
  type SocketData,
  type TaskChangedDto,
} from '../src/realtime/types.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ADMIN_ID = 'admin-1';
const PM_A = 'pm-a';
const PM_B = 'pm-b';
const DEV_A = 'dev-a';
const DEV_B = 'dev-b';

const socketData = (role: Role, userId: string): SocketData => ({
  userId,
  role,
  email: `${userId}@velozity.test`,
  name: userId,
  avatarColor: '#000000',
});

const principal = (role: Role, id: string): Principal => ({
  id,
  role,
  email: `${id}@velozity.test`,
  name: id,
});

const PRINCIPALS = [
  socketData(Role.ADMIN, ADMIN_ID),
  socketData(Role.PROJECT_MANAGER, PM_A),
  socketData(Role.PROJECT_MANAGER, PM_B),
  socketData(Role.DEVELOPER, DEV_A),
  socketData(Role.DEVELOPER, DEV_B),
];

/** Every interesting combination of owning manager and assignee. */
const TASKS = [
  { projectManagerId: PM_A, assigneeId: DEV_A },
  { projectManagerId: PM_A, assigneeId: DEV_B },
  { projectManagerId: PM_B, assigneeId: DEV_A },
  { projectManagerId: PM_B, assigneeId: DEV_B },
  { projectManagerId: PM_A, assigneeId: null },
  { projectManagerId: PM_B, assigneeId: null },
];

/**
 * Evaluates the Prisma fragment `taskScope` returns against a plain task.
 *
 * Deliberately narrow: it understands only the three shapes `taskScope` can
 * produce, and throws on anything else. If a future change to the scope emits
 * a fragment this cannot interpret, the failure is loud here — which is the
 * correct outcome, because the socket-side predicate would then need the same
 * new logic.
 */
const scopeAdmits = (p: Principal, task: { projectManagerId: string; assigneeId: string | null }): boolean => {
  const where = taskScope(p) as Record<string, unknown>;
  const keys = Object.keys(where);

  if (keys.length === 0) return true; // {} — unfiltered
  if (keys.length === 1 && 'assigneeId' in where) return task.assigneeId === where.assigneeId;
  if (keys.length === 1 && 'project' in where) {
    const project = where.project as { managerId?: string };
    return task.projectManagerId === project.managerId;
  }

  throw new Error(
    `taskScope returned a fragment this test cannot interpret: ${JSON.stringify(where)}. ` +
      'If the scope changed shape, principalCanSeeTask in fanout.ts almost certainly needs the same change.',
  );
};

/* ------------------------------------------------------------------ *
 * 1. Parity between the socket predicate and the database scope
 * ------------------------------------------------------------------ */

describe('principalCanSeeTask / taskScope parity', () => {
  it('agrees with the database scope for every role and task combination', () => {
    for (const data of PRINCIPALS) {
      const p = principal(data.role, data.userId);
      for (const task of TASKS) {
        expect(
          principalCanSeeTask(data, task),
          `socket and SQL disagreed for ${data.role} ${data.userId} on ` +
            `task(manager=${task.projectManagerId}, assignee=${String(task.assigneeId)})`,
        ).toBe(scopeAdmits(p, task));
      }
    }
  });

  it('admits an admin to everything', () => {
    const data = socketData(Role.ADMIN, ADMIN_ID);
    for (const task of TASKS) expect(principalCanSeeTask(data, task)).toBe(true);
  });

  it('admits a manager only to their own projects', () => {
    const data = socketData(Role.PROJECT_MANAGER, PM_A);
    expect(principalCanSeeTask(data, { projectManagerId: PM_A, assigneeId: DEV_B })).toBe(true);
    expect(principalCanSeeTask(data, { projectManagerId: PM_B, assigneeId: DEV_B })).toBe(false);
  });

  it("admits a developer only to their own assignment, even in the same project", () => {
    const data = socketData(Role.DEVELOPER, DEV_A);
    expect(principalCanSeeTask(data, { projectManagerId: PM_A, assigneeId: DEV_A })).toBe(true);
    expect(principalCanSeeTask(data, { projectManagerId: PM_A, assigneeId: DEV_B })).toBe(false);
    expect(principalCanSeeTask(data, { projectManagerId: PM_A, assigneeId: null })).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Room naming
 * ------------------------------------------------------------------ */

describe('room names', () => {
  it('namespaces the three room kinds so a user id can never collide with a project id', () => {
    expect(roomForUser('x')).toBe('user:x');
    expect(roomForProject('x')).toBe('project:x');
    expect(roomForRole(Role.ADMIN)).toBe('role:ADMIN');
    expect(new Set([roomForUser('x'), roomForProject('x'), roomForRole(Role.ADMIN)]).size).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * 3. emitTaskChanged re-authorises rather than broadcasting
 * ------------------------------------------------------------------ */

interface FakeSocket {
  id: string;
  data: SocketData;
  rooms: Set<string>;
  received: TaskChangedDto[];
  emit: (event: string, payload: TaskChangedDto) => void;
}

const fakeSocket = (id: string, data: SocketData, rooms: string[]): FakeSocket => {
  const socket: FakeSocket = {
    id,
    data,
    rooms: new Set(rooms),
    received: [],
    emit: (_event, payload) => {
      socket.received.push(payload);
    },
  };
  return socket;
};

/**
 * The narrowest stand-in for a Socket.IO server that `emitTaskChanged` and
 * `emitTaskRemoved` actually use: `in(rooms).fetchSockets()` and
 * `to(rooms).emit()`. Using a fake rather than a live server keeps the test
 * about the authorisation decision instead of about transport timing.
 */
const fakeIO = (sockets: FakeSocket[]) => {
  const select = (rooms: string | string[]): FakeSocket[] => {
    const wanted = new Set(Array.isArray(rooms) ? rooms : [rooms]);
    return sockets.filter((s) => [...s.rooms].some((room) => wanted.has(room)));
  };

  return {
    in: (rooms: string | string[]) => ({ fetchSockets: async () => select(rooms) }),
    to: (rooms: string | string[]) => ({
      emit: (event: string, payload: TaskChangedDto) => {
        for (const s of select(rooms)) s.emit(event, payload);
      },
    }),
  } as unknown as AppIOServer;
};

const PROJECT = 'project-1';

const changed = (assigneeId: string | null): TaskChangedDto =>
  ({
    id: 'task-1',
    number: 12,
    projectId: PROJECT,
    assigneeId,
    status: 'IN_REVIEW',
    changeKind: 'updated',
  }) as unknown as TaskChangedDto;

describe('emitTaskChanged', () => {
  it('delivers to viewers who are authorised and skips viewers who are not', async () => {
    // All four are in the project room — i.e. all four are looking at the
    // board. Room membership is "is viewing", never "is allowed to see".
    const adminSocket = fakeSocket('s-admin', socketData(Role.ADMIN, ADMIN_ID), [
      roomForProject(PROJECT),
      roomForRole(Role.ADMIN),
      roomForUser(ADMIN_ID),
    ]);
    const ownerPm = fakeSocket('s-pm-a', socketData(Role.PROJECT_MANAGER, PM_A), [
      roomForProject(PROJECT),
      roomForUser(PM_A),
    ]);
    const otherPm = fakeSocket('s-pm-b', socketData(Role.PROJECT_MANAGER, PM_B), [
      roomForProject(PROJECT),
      roomForUser(PM_B),
    ]);
    const assignee = fakeSocket('s-dev-a', socketData(Role.DEVELOPER, DEV_A), [
      roomForProject(PROJECT),
      roomForUser(DEV_A),
    ]);
    const peer = fakeSocket('s-dev-b', socketData(Role.DEVELOPER, DEV_B), [
      roomForProject(PROJECT),
      roomForUser(DEV_B),
    ]);

    const io = fakeIO([adminSocket, ownerPm, otherPm, assignee, peer]);

    await emitTaskChanged(io, changed(DEV_A), { projectManagerId: PM_A, assigneeId: DEV_A, actorId: DEV_A });

    expect(adminSocket.received).toHaveLength(1);
    expect(ownerPm.received).toHaveLength(1);
    expect(assignee.received).toHaveLength(1);

    // The two that matter: a manager who does not own the project, and a
    // developer who is not the assignee, are both watching the same board.
    expect(otherPm.received).toHaveLength(0);
    expect(peer.received).toHaveLength(0);
  });

  it('reaches the assignee and owning manager when they are not on the board', async () => {
    // They may have the task open in a dashboard or "my tasks" list instead,
    // so they are in their user room but not the project room.
    const assignee = fakeSocket('s-dev-a', socketData(Role.DEVELOPER, DEV_A), [roomForUser(DEV_A)]);
    const ownerPm = fakeSocket('s-pm-a', socketData(Role.PROJECT_MANAGER, PM_A), [roomForUser(PM_A)]);
    const io = fakeIO([assignee, ownerPm]);

    await emitTaskChanged(io, changed(DEV_A), { projectManagerId: PM_A, assigneeId: DEV_A, actorId: PM_A });

    expect(assignee.received).toHaveLength(1);
    expect(ownerPm.received).toHaveLength(1);
  });

  it('never delivers the same event twice to a socket in several matching rooms', async () => {
    // An admin viewing the board matches the project room, role:ADMIN and
    // their own user room. Both passes must not double up.
    const adminSocket = fakeSocket('s-admin', socketData(Role.ADMIN, ADMIN_ID), [
      roomForProject(PROJECT),
      roomForRole(Role.ADMIN),
      roomForUser(ADMIN_ID),
    ]);
    const io = fakeIO([adminSocket]);

    await emitTaskChanged(io, changed(DEV_A), { projectManagerId: PM_A, assigneeId: DEV_A, actorId: ADMIN_ID });

    expect(adminSocket.received).toHaveLength(1);
  });

  it('withholds an unassigned task from every developer while still reaching the manager', async () => {
    const dev = fakeSocket('s-dev-a', socketData(Role.DEVELOPER, DEV_A), [
      roomForProject(PROJECT),
      roomForUser(DEV_A),
    ]);
    const ownerPm = fakeSocket('s-pm-a', socketData(Role.PROJECT_MANAGER, PM_A), [
      roomForProject(PROJECT),
      roomForUser(PM_A),
    ]);
    const io = fakeIO([dev, ownerPm]);

    await emitTaskChanged(io, changed(null), { projectManagerId: PM_A, assigneeId: null, actorId: PM_A });

    expect(dev.received).toHaveLength(0);
    expect(ownerPm.received).toHaveLength(1);
  });

  it('ignores a socket that has not completed authentication', async () => {
    const anonymous = fakeSocket('s-anon', { userId: '' } as SocketData, [roomForProject(PROJECT)]);
    const io = fakeIO([anonymous]);

    await emitTaskChanged(io, changed(DEV_A), { projectManagerId: PM_A, assigneeId: DEV_A });

    expect(anonymous.received).toHaveLength(0);
  });
});

describe('emitTaskRemoved', () => {
  it('tells a previous assignee the task has left their view, and nobody else', async () => {
    // After a reassignment the old assignee fails `principalCanSeeTask`, so
    // `emitTaskChanged` correctly skips them — and their board would keep a
    // stale card. This is the explicit retraction.
    const previous = fakeSocket('s-dev-a', socketData(Role.DEVELOPER, DEV_A), [roomForUser(DEV_A)]);
    const unrelated = fakeSocket('s-dev-b', socketData(Role.DEVELOPER, DEV_B), [roomForUser(DEV_B)]);
    const io = fakeIO([previous, unrelated]);

    emitTaskRemoved(io, DEV_A, changed(DEV_B));

    expect(previous.received).toHaveLength(1);
    expect(previous.received[0]?.changeKind).toBe('deleted');
    expect(unrelated.received).toHaveLength(0);
  });
});
