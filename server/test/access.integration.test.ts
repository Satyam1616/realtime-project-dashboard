/**
 * End-to-end access-control tests, driven through the real Fastify app.
 *
 * test/rbac.test.ts proves the *rules* are right. This file proves the
 * *handlers apply them* — which is the claim the brief actually makes:
 *
 *   "A Developer must not be able to reach a Project Manager's data even by
 *    directly hitting the API endpoint with a modified token."
 *
 * So there is no mocking here and no test double for authorisation. Requests go
 * in through `app.inject()` carrying real bearer tokens minted by the real
 * login route, hit the real handlers and the real database, and the assertions
 * are on status codes and payloads. A unit test cannot make this claim: a
 * handler that forgets to AND in its scope would still pass every test in
 * rbac.test.ts.
 *
 * Requires a seeded database:
 *
 *     npm run db:up && npm run db:migrate && npm run db:seed
 *
 * If Postgres is unreachable the suite skips rather than fails, so that
 * `npm test` on a fresh clone still runs the pure tiers. A skip is reported
 * loudly — read the console note if you expected these to run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/client.js';

/* ------------------------------------------------------------------ *
 * Fixtures — the seed's stable identities
 * ------------------------------------------------------------------ */

const PASSWORD = env.SEED_PASSWORD;

const PEOPLE = {
  admin: 'priya@velozity.dev',
  pmA: 'arjun@velozity.dev',
  pmB: 'neha@velozity.dev',
  devA: 'ravi@velozity.dev',
  devB: 'mei@velozity.dev',
} as const;

type Who = keyof typeof PEOPLE;

interface Session {
  token: string;
  userId: string;
  cookie: string;
}

let app: FastifyInstance;
let available = false;
const sessions = {} as Record<Who, Session>;

/** Signs in through the real route, so the token is minted the real way. */
const signIn = async (email: string): Promise<Session> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });

  if (res.statusCode !== 200) {
    throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  }

  const body = res.json() as { accessToken: string; user: { id: string } };
  const setCookie = res.cookies.find((c) => c.name === env.COOKIE_NAME);
  if (!setCookie) throw new Error('login did not set the refresh cookie');

  return { token: body.accessToken, userId: body.user.id, cookie: `${setCookie.name}=${setCookie.value}` };
};

/**
 * Issues a request as one of the seeded people.
 *
 * The options are assembled into a typed `InjectOptions` first: passing the
 * object literal inline leaves `inject`'s overloads unresolved, because the
 * conditional `payload` spread produces a shape TypeScript cannot match
 * against either signature, and the call then types as their intersection.
 */
const as = (
  who: Who,
  url: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  payload?: unknown,
): Promise<LightMyRequestResponse> => {
  const options: InjectOptions = {
    method,
    url,
    headers: { authorization: `Bearer ${sessions[who].token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  };
  return app.inject(options);
};

/** Extracts the row list regardless of which envelope a route uses. */
const rows = (body: unknown): Array<Record<string, unknown>> => {
  const b = body as Record<string, unknown>;
  for (const key of ['items', 'data', 'tasks', 'projects', 'events', 'notifications', 'users', 'clients']) {
    if (Array.isArray(b[key])) return b[key] as Array<Record<string, unknown>>;
  }
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  throw new Error(`no row array in ${JSON.stringify(body).slice(0, 200)}`);
};

beforeAll(async () => {
  try {
    await prisma.$queryRaw`select 1`;
    available = true;
  } catch {
    console.warn(
      '\n  ⚠ access.integration.test.ts skipped: no database reachable at DATABASE_URL.' +
        '\n    Run `npm run db:up && npm run db:migrate && npm run db:seed` to enable it.\n',
    );
    return;
  }

  app = await buildApp();
  await app.ready();

  for (const [who, email] of Object.entries(PEOPLE)) {
    sessions[who as Who] = await signIn(email);
  }
});

afterAll(async () => {
  if (app) await app.close();
  await prisma.$disconnect().catch(() => undefined);
});

/* ------------------------------------------------------------------ *
 * 1. Authentication is required, and the token must be genuine
 * ------------------------------------------------------------------ */

describe('authentication', () => {
  it('refuses an unauthenticated request', async () => {
    if (!available) return;
    const res = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a malformed bearer token', async () => {
    if (!available) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('never leaks a stack trace, and always names the request', async () => {
    if (!available) return;
    const res = await app.inject({ method: 'GET', url: '/api/dashboard' });
    const body = res.json() as { error?: { code?: string; message?: string }; requestId?: string; stack?: unknown };

    expect(body.error?.code).toBeTruthy();
    expect(body.error?.message).toBeTruthy();
    expect(body.requestId).toBeTruthy();
    expect(res.body).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no "at fn (file:1:2)" frames
    expect(body).not.toHaveProperty('stack');
  });
});

/* ------------------------------------------------------------------ *
 * 2. Forged and tampered tokens — the brief's "modified token"
 * ------------------------------------------------------------------ */

describe('token forgery', () => {
  /** Rebuilds a token from the real claims with `mutate` applied. */
  const forge = (
    who: Who,
    mutate: (claims: Record<string, unknown>) => Record<string, unknown>,
    options: { secret?: string; keepSignature?: boolean; algNone?: boolean } = {},
  ): string => {
    const original = sessions[who].token;
    const [header, payload, signature] = original.split('.');
    const claims = mutate(JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>);
    const encode = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

    if (options.algNone) {
      return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
    }
    if (options.keepSignature) {
      return `${header}.${encode(claims)}.${signature}`;
    }
    return jwt.sign(claims, options.secret ?? 'an-attacker-chosen-secret', { algorithm: 'HS256' });
  };

  const cases: Array<[string, () => string]> = [
    [
      'role escalated to ADMIN, original signature kept',
      () => forge('devA', (c) => ({ ...c, role: 'ADMIN' }), { keepSignature: true }),
    ],
    [
      'subject swapped for the admin, original signature kept',
      () => forge('devA', (c) => ({ ...c, sub: sessions.admin.userId }), { keepSignature: true }),
    ],
    ['alg set to "none" with no signature', () => forge('devA', (c) => ({ ...c, role: 'ADMIN' }), { algNone: true })],
    [
      're-signed with an attacker-chosen secret',
      () => forge('devA', (c) => ({ ...c, role: 'ADMIN' })),
    ],
    [
      // This is the reason .env.example insists the two secrets differ. If they
      // were the same string, a refresh token would be accepted as an access
      // token and this test would return 200.
      'access token signed with the refresh secret',
      () => forge('devA', (c) => ({ ...c, role: 'ADMIN' }), { secret: env.JWT_REFRESH_SECRET }),
    ],
    [
      'a refresh token replayed in the Authorization header',
      () => jwt.sign({ sub: sessions.devA.userId, typ: 'refresh' }, env.JWT_REFRESH_SECRET, { algorithm: 'HS256' }),
    ],
    [
      'expired but otherwise perfectly valid',
      () =>
        jwt.sign(
          { sub: sessions.admin.userId, role: 'ADMIN', typ: 'access', iat: 1, exp: 2 },
          env.JWT_ACCESS_SECRET,
          { algorithm: 'HS256' },
        ),
    ],
  ];

  for (const [name, build] of cases) {
    it(`rejects a token with ${name}`, async () => {
      if (!available) return;
      for (const url of ['/api/dashboard', '/api/users', '/api/tasks', '/api/activity']) {
        const res = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${build()}` },
        });
        expect(res.statusCode, `${name} on ${url}`).toBe(401);
      }
    });
  }

  it('trusts the database over the token for role, not the claim', async () => {
    if (!available) return;
    // A correctly-signed token whose role claim has been swapped. Signing it
    // requires the real secret, so this models a stolen key or a bug in the
    // issuer rather than an outsider — and it still must not escalate, because
    // the principal is resolved from the database on every request.
    const escalated = jwt.sign(
      {
        sub: sessions.devA.userId,
        email: PEOPLE.devA,
        name: 'Ravi Verma',
        role: 'ADMIN',
        typ: 'access',
        aud: 'velozity-web',
        iss: 'velozity-api',
      },
      env.JWT_ACCESS_SECRET,
      { algorithm: 'HS256', expiresIn: '5m' },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${escalated}` },
    });
    expect(res.statusCode).toBe(403);

    const dash = await app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { authorization: `Bearer ${escalated}` },
    });
    expect(dash.statusCode).toBe(200);
    expect((dash.json() as { variant: string }).variant).toBe('developer');
  });
});

/* ------------------------------------------------------------------ *
 * 3. Role gates on admin-only routes
 * ------------------------------------------------------------------ */

describe('role gates', () => {
  const adminOnly: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown?]> = [
    ['GET', '/api/users'],
    ['POST', '/api/users', { email: 'x@velozity.dev', name: 'X', role: 'DEVELOPER', password: 'Password123!' }],
    ['POST', '/api/clients', { name: 'Acme' }],
  ];

  for (const [method, url, payload] of adminOnly) {
    it(`refuses a developer on ${method} ${url}`, async () => {
      if (!available) return;
      const res = await as('devA', url, method, payload);
      expect(res.statusCode).toBe(403);
    });

    it(`refuses a project manager on ${method} ${url}`, async () => {
      if (!available) return;
      const res = await as('pmA', url, method, payload);
      expect(res.statusCode).toBe(403);
    });
  }

  it('lets an admin read the user list', async () => {
    if (!available) return;
    const res = await as('admin', '/api/users');
    expect(res.statusCode).toBe(200);
    expect(rows(res.json()).length).toBeGreaterThanOrEqual(7);
  });

  it('lets a manager read clients but not write them', async () => {
    if (!available) return;
    expect((await as('pmA', '/api/clients')).statusCode).toBe(200);
    expect((await as('pmA', '/api/clients', 'POST', { name: 'Acme' })).statusCode).toBe(403);
  });

  it('refuses a developer the client list entirely', async () => {
    if (!available) return;
    expect((await as('devA', '/api/clients')).statusCode).toBe(403);
  });

  it('refuses a developer project and task creation', async () => {
    if (!available) return;
    expect((await as('devA', '/api/projects', 'POST', { name: 'Mine' })).statusCode).toBe(403);
    expect((await as('devA', '/api/tasks', 'POST', { title: 'Mine' })).statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Row-level scoping — the part a role gate alone cannot give you
 * ------------------------------------------------------------------ */

describe('project scoping', () => {
  it('shows each manager only their own portfolio, and the admin the union', async () => {
    if (!available) return;
    const ids = async (who: Who): Promise<Set<string>> =>
      new Set(rows((await as(who, '/api/projects')).json()).map((p) => p.id as string));

    const [a, b, all] = [await ids('pmA'), await ids('pmB'), await ids('admin')];

    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);
    // Disjoint portfolios, both contained in the admin's view.
    expect([...a].filter((id) => b.has(id))).toEqual([]);
    for (const id of [...a, ...b]) expect(all.has(id)).toBe(true);
  });

  it("gives a manager 404 — not 403 — for another manager's project", async () => {
    if (!available) return;
    // 404 so that probing cannot confirm the id exists.
    const theirs = rows((await as('pmB', '/api/projects')).json())[0]!.id as string;

    expect((await as('pmA', `/api/projects/${theirs}`)).statusCode).toBe(404);
    expect((await as('pmA', `/api/projects/${theirs}`, 'PATCH', { name: 'Hijacked' })).statusCode).toBe(404);
    expect((await as('pmB', `/api/projects/${theirs}`)).statusCode).toBe(200);
    expect((await as('admin', `/api/projects/${theirs}`)).statusCode).toBe(200);
  });

  it('keeps project deletion away from the owning manager', async () => {
    if (!available) return;
    const mine = rows((await as('pmA', '/api/projects')).json())[0]!.id as string;
    expect((await as('pmA', `/api/projects/${mine}`, 'DELETE')).statusCode).toBe(403);
  });
});

describe('task scoping', () => {
  it('returns only a developer\'s own assignments', async () => {
    if (!available) return;
    const mine = rows((await as('devA', '/api/tasks?limit=100')).json());
    expect(mine.length).toBeGreaterThan(0);
    for (const task of mine) {
      expect((task.assignee as { id: string } | null)?.id).toBe(sessions.devA.userId);
    }
  });

  it("gives a developer 404 for a peer's task, on read and on write", async () => {
    if (!available) return;
    const peers = rows((await as('devB', '/api/tasks?limit=100')).json());
    const peerTask = peers.find((t) => (t.assignee as { id: string } | null)?.id === sessions.devB.userId);
    expect(peerTask, 'devB should own at least one task in the seed').toBeTruthy();
    const id = peerTask!.id as string;

    expect((await as('devA', `/api/tasks/${id}`)).statusCode).toBe(404);
    // With a well-formed body, so this is the scope refusing — not the validator.
    expect((await as('devA', `/api/tasks/${id}`, 'PATCH', { status: 'DONE' })).statusCode).toBe(404);
    expect((await as('devB', `/api/tasks/${id}`)).statusCode).toBe(200);
  });

  it('refuses a developer marking their own task Done, but allows In Review', async () => {
    if (!available) return;
    const mine = rows((await as('devA', '/api/tasks?limit=100')).json());
    const movable = mine.find((t) => t.status !== 'DONE');
    expect(movable).toBeTruthy();
    const id = movable!.id as string;
    const original = movable!.status as string;

    const done = await as('devA', `/api/tasks/${id}`, 'PATCH', { status: 'DONE' });
    expect(done.statusCode).toBe(403);

    const review = await as('devA', `/api/tasks/${id}`, 'PATCH', { status: 'IN_REVIEW' });
    expect(review.statusCode).toBe(200);

    // Put it back, so re-running the suite is idempotent.
    await as('pmA', `/api/tasks/${id}`, 'PATCH', { status: original });
  });

  it('refuses a developer reassigning or re-prioritising their own task', async () => {
    if (!available) return;
    const id = rows((await as('devA', '/api/tasks?limit=100')).json())[0]!.id as string;

    expect((await as('devA', `/api/tasks/${id}`, 'PATCH', { assigneeId: sessions.devB.userId })).statusCode).toBe(403);
    expect((await as('devA', `/api/tasks/${id}`, 'PATCH', { priority: 'CRITICAL' })).statusCode).toBe(403);
    expect((await as('devA', `/api/tasks/${id}`, 'PATCH', { dueDate: '2031-01-01T00:00:00.000Z' })).statusCode).toBe(403);
  });
});

/* ------------------------------------------------------------------ *
 * 5. The activity feed answers differently per role
 * ------------------------------------------------------------------ */

describe('activity scoping', () => {
  it('narrows strictly from admin to manager to developer', async () => {
    if (!available) return;
    const count = async (who: Who): Promise<number> =>
      rows((await as(who, '/api/activity?limit=50')).json()).length;

    expect(await count('admin')).toBeGreaterThanOrEqual(await count('pmA'));
    expect(await count('pmA')).toBeGreaterThanOrEqual(await count('devA'));
  });

  it("contains only events on a developer's own tasks", async () => {
    if (!available) return;
    const feed = rows((await as('devA', '/api/activity?limit=50')).json());
    const mine = new Set(rows((await as('devA', '/api/tasks?limit=100')).json()).map((t) => t.id as string));

    expect(feed.length).toBeGreaterThan(0);
    for (const event of feed) {
      // Project-level events have no taskId and are not a developer's to see.
      expect(event.taskId, JSON.stringify(event)).not.toBeNull();
      expect(mine.has(event.taskId as string)).toBe(true);
    }
  });

  it('returns the missed events from the database, capped at twenty', async () => {
    if (!available) return;
    const res = await as('devA', '/api/activity/catchup');
    expect(res.statusCode).toBe(200);

    const body = res.json() as { events: unknown[]; missedCount: number; latestSeq: number; lastSeenSeq: number };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeLessThanOrEqual(20);
    expect(typeof body.latestSeq).toBe('number');
    // The high-water mark is persisted per user, which is what makes catch-up
    // survive a server restart — an in-memory buffer would not.
    expect(typeof body.lastSeenSeq).toBe('number');
  });

  it('refuses an unauthenticated catch-up', async () => {
    if (!available) return;
    expect((await app.inject({ method: 'GET', url: '/api/activity/catchup' })).statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Notifications are addressed, never browsable
 * ------------------------------------------------------------------ */

describe('notifications', () => {
  it('returns only the caller\'s own notifications', async () => {
    if (!available) return;
    for (const who of ['admin', 'pmA', 'devA'] as Who[]) {
      const res = await as(who, '/api/notifications');
      expect(res.statusCode).toBe(200);
      for (const n of rows(res.json())) {
        if (n.recipientId !== undefined) expect(n.recipientId).toBe(sessions[who].userId);
      }
    }
  });

  it("refuses to mark another user's notification read", async () => {
    if (!available) return;
    const theirs = rows((await as('devA', '/api/notifications')).json())[0];
    if (!theirs) return;
    const res = await as('devB', `/api/notifications/${theirs.id as string}/read`, 'POST');
    expect([403, 404]).toContain(res.statusCode);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Input validation and the refresh-token contract
 * ------------------------------------------------------------------ */

describe('self-service registration', () => {
  /** Unique per run, so a re-run does not collide on the email unique index. */
  const fresh = (): string => `signup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const GOOD_PASSWORD = 'Registr4tionTest!';

  const registered: string[] = [];

  const signUp = async (payload: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'POST', url: '/api/auth/register', payload });

  afterAll(async () => {
    // Keep the fixture's counts stable for every other suite and for the next run.
    if (registered.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: registered } } });
    }
  });

  it('creates an account and signs it in', async () => {
    if (!available) return;

    const email = fresh();
    const res = await signUp({ email, name: 'Test Person', password: GOOD_PASSWORD });

    expect(res.statusCode).toBe(201);
    registered.push(email);

    const body = res.json() as { user: { role: string; email: string }; accessToken: string };
    expect(body.user.email).toBe(email);
    expect(body.accessToken).toBeTruthy();

    // The refresh cookie must be set, HttpOnly, and scoped to the auth routes —
    // the same contract the login route is held to.
    const cookie = res.headers['set-cookie'];
    const raw = Array.isArray(cookie) ? cookie.join(';') : String(cookie ?? '');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Path=/api/auth');
  });

  /**
   * The point of the whole route.
   *
   * If this ever fails, anyone on the internet can mint themselves an admin, and
   * every scope rule in rbac.ts becomes decorative.
   */
  it('ignores a role supplied by the caller and always creates a DEVELOPER', async () => {
    if (!available) return;

    const email = fresh();
    const res = await signUp({
      email,
      name: 'Escalation Attempt',
      password: GOOD_PASSWORD,
      role: 'ADMIN',
    });

    expect(res.statusCode).toBe(201);
    registered.push(email);

    expect((res.json() as { user: { role: string } }).user.role).toBe('DEVELOPER');

    // Assert against the row, not just the response: a handler could return a
    // sanitised DTO while having written something else.
    const stored = await prisma.user.findUnique({ where: { email }, select: { role: true } });
    expect(stored?.role).toBe('DEVELOPER');
  });

  it('refuses a duplicate email with 409 rather than overwriting the account', async () => {
    if (!available) return;

    const res = await signUp({
      email: PEOPLE.admin,
      name: 'Impostor',
      password: GOOD_PASSWORD,
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CONFLICT');

    // The seeded admin is untouched.
    const stored = await prisma.user.findUnique({
      where: { email: PEOPLE.admin },
      select: { role: true, name: true },
    });
    expect(stored?.role).toBe('ADMIN');
    expect(stored?.name).toBe('Priya Sharma');
  });

  it('enforces the password policy with field-level detail', async () => {
    if (!available) return;

    const res = await signUp({ email: fresh(), name: 'Weak Password', password: 'short' });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; details?: Array<{ path: string }> } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.some((detail) => detail.path === 'password')).toBe(true);
  });

  it('rejects a malformed email without creating anything', async () => {
    if (!available) return;

    const res = await signUp({ email: 'not-an-email', name: 'Bad Email', password: GOOD_PASSWORD });
    expect(res.statusCode).toBe(400);
  });
});

describe('input validation', () => {
  it('rejects an unknown enum value rather than ignoring the filter', async () => {
    if (!available) return;
    // Silently dropping an unrecognised filter is the dangerous failure: the
    // caller believes they are looking at a narrowed list.
    expect((await as('admin', '/api/tasks?status=NONSENSE')).statusCode).toBe(400);
    expect((await as('admin', '/api/tasks?priority=URGENT')).statusCode).toBe(400);
  });

  it('rejects an out-of-range limit', async () => {
    if (!available) return;
    expect((await as('admin', '/api/tasks?limit=99999')).statusCode).toBe(400);
    expect((await as('admin', '/api/tasks?limit=0')).statusCode).toBe(400);
  });

  it('rejects a malformed id without reaching the database', async () => {
    if (!available) return;
    expect((await as('admin', '/api/tasks/not-a-uuid')).statusCode).toBe(400);
  });

  it('accepts the documented filters and applies them', async () => {
    if (!available) return;
    const res = await as('admin', '/api/tasks?status=IN_REVIEW&priority=CRITICAL&limit=100');
    expect(res.statusCode).toBe(200);
    for (const task of rows(res.json())) {
      expect(task.status).toBe('IN_REVIEW');
      expect(task.priority).toBe('CRITICAL');
    }
  });

  it('returns field-level detail on a bad create payload', async () => {
    if (!available) return;
    const res = await as('admin', '/api/clients', 'POST', { name: '' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; details?: unknown[] } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

/* ------------------------------------------------------------------ *
 * 7. CORS: the allowlist is enforced, and refusal uses the envelope
 * ------------------------------------------------------------------ */

describe('CORS origin allowlist', () => {
  const ALLOWED = 'http://localhost:5173';
  const DISALLOWED = 'https://evil.example.com';

  it('allows a configured origin with credentials', async () => {
    if (!available) return;
    // `credentials: true` is what makes the refresh cookie work cross-site, and
    // a browser requires the exact origin to be echoed — a wildcard is refused
    // for credentialed requests.
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: { origin: ALLOWED, 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('refuses an origin outside the allowlist without echoing it back', async () => {
    if (!available) return;
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: { origin: DISALLOWED, 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reports a refused origin as 403 in the standard envelope, not a 500', async () => {
    if (!available) return;
    // Regression: the rejection used to be a bare `Error`, which @fastify/cors
    // surfaces as a 500 in Fastify's own `{statusCode, error, message}` shape.
    // That blamed the server for a caller mistake and broke the single envelope
    // every other route returns — so a client's error handling would not
    // recognise it, and a misconfigured CORS_ORIGINS logged a stack per request.
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: DISALLOWED, 'content-type': 'application/json' },
      payload: { email: 'ravi@velozity.dev', password: 'Password123!' },
    });

    expect(res.statusCode).toBe(403);

    const body = res.json() as { error?: { code?: string; message?: string }; requestId?: string };
    expect(body.error?.code).toBe('FORBIDDEN');
    expect(body.requestId).toBeTruthy();
    expect(body).not.toHaveProperty('statusCode'); // Fastify's default shape

    // The refusal names the origin — useful when the cause is a misconfigured
    // CORS_ORIGINS — but must not leak a stack trace.
    expect(body.error?.message).toContain(DISALLOWED);
    expect(JSON.stringify(body)).not.toMatch(/\bat \/|\.js:\d+/);
  });

  it('allows a request with no Origin header at all', async () => {
    if (!available) return;
    // curl, server-to-server calls and the container health check send none.
    // Refusing them would break the load balancer's liveness probe.
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

describe('refresh tokens', () => {
  it('sets the refresh token as an HttpOnly cookie and never returns it in the body', async () => {
    if (!available) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: PEOPLE.devB, password: PASSWORD },
    });

    const cookie = res.cookies.find((c) => c.name === env.COOKIE_NAME);
    expect(cookie).toBeTruthy();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite?.toLowerCase()).toBeDefined();
    // Scoped to the only prefix that needs it, so it is not attached to every
    // request the app makes.
    expect(cookie!.path).toBe('/api/auth');

    expect(res.body).not.toContain(cookie!.value);
    expect(res.json()).not.toHaveProperty('refreshToken');
  });

  it('refreshes from the cookie alone, with no Authorization header', async () => {
    if (!available) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: sessions.devB.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { accessToken: string }).accessToken).toBeTruthy();
    // Rotated, so a captured cookie has a bounded useful life.
    expect(res.cookies.find((c) => c.name === env.COOKIE_NAME)).toBeTruthy();
  });

  it('refuses a refresh with no cookie', async () => {
    if (!available) return;
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh' })).statusCode).toBe(401);
  });

  it('refuses a refresh token forged with the access secret', async () => {
    if (!available) return;
    const forged = jwt.sign({ sub: sessions.admin.userId, typ: 'refresh' }, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: '7d',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: `${env.COOKIE_NAME}=${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
