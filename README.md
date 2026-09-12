# Velozity — Real-Time Client Project Dashboard

An internal agency tool for managing client projects, tracking task progress and watching
team activity live. Three roles see three genuinely different applications over one API:
an **Admin** sees the agency, a **Project Manager** sees their own portfolio, a
**Developer** sees only the work assigned to them.

> **Live demo:** _(deployed link)_ · sign in with any account in [Demo accounts](#demo-accounts).

---

## Contents

- [Quick start](#quick-start) · [Demo accounts](#demo-accounts) · [Scripts](#scripts)
- [What each role can do](#what-each-role-can-do)
- [Architecture](#architecture)
- [Database schema](#database-schema) · [Index rationale](#index-rationale)
- [Architectural decisions](#architectural-decisions)
  - [Fastify over Express](#1-fastify-over-express)
  - [Socket.IO over a bare `ws` server](#2-socketio-over-a-bare-ws-server)
  - [node-cron over Bull](#3-node-cron-over-bull)
  - [Token storage](#4-token-storage-httponly-cookie--in-memory-access-token)
  - [Real-time role filtering](#5-how-the-feed-is-role-filtered)
- [API reference](#api-reference)
- [Deployment](#deployment)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Explanation](#explanation)

---

## Quick start

Requires **Node ≥ 20.11** and **Docker**.

```bash
git clone <repo-url> velozity && cd velozity

# 1. Secrets. Only server/.env is required, and only two values in it have no default.
cp server/.env.example server/.env
node -e "console.log('JWT_ACCESS_SECRET='+require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('JWT_REFRESH_SECRET='+require('crypto').randomBytes(48).toString('base64url'))"
# …paste both into server/.env. They MUST be different strings — see §4.

# 2. Optional: one-click demo sign-in buttons on the login page.
cp web/.env.example web/.env      # then set VITE_DEMO_PASSWORD=Password123!

# 3. Everything else. `setup` = npm install → postgres container → migrate → seed.
npm run setup
npm run dev                        # API on :4000, web on :5173
```

Open **<http://localhost:5173>**. The root `.env.example` is *not* needed unless you hit the
port conflict below — application secrets never live there, only the handful of values
docker-compose itself interpolates.

<details>
<summary><b>Fully containerised run (API + database in Docker)</b></summary>

```bash
docker compose --profile full up -d --build
```

The API container applies pending migrations and seeds an empty database on first boot
(`RUN_MIGRATIONS_ON_BOOT`, `SEED_ON_BOOT`). It reads `server/.env` — the same file
`npm run dev` uses — so there is no second env file to keep in sync. Secrets are never
written into `docker-compose.yml` or baked into the image.
</details>

<details>
<summary><b>Port 5432 already in use</b></summary>

A locally installed Postgres will shadow the container and you will get confusing
"relation does not exist" errors while connected to the wrong server. Move the container:

```bash
echo "POSTGRES_PORT=5433" >> .env
# then in server/.env:
DATABASE_URL=postgresql://velozity:velozity@localhost:5433/velozity?schema=public
```
</details>

### Demo accounts

All seeded accounts share the password in `SEED_PASSWORD` (`Password123!` by default).

| Role | Email | Sees |
|---|---|---|
| Admin | `priya@velozity.dev` | Everything, plus live online-user presence |
| Project Manager | `arjun@velozity.dev` | Their own projects and their team's activity |
| Project Manager | `neha@velozity.dev` | A **disjoint** portfolio — good for testing isolation |
| Developer | `ravi@velozity.dev` | Only tasks assigned to them |
| Developer | `sana@velozity.dev` / `daniel@velozity.dev` / `mei@velozity.dev` | Same, different assignments |

To enable the one-click sign-in buttons on the login page, add
`VITE_DEMO_PASSWORD=Password123!` to `web/.env`. It is a seeded demo credential, not a
secret — but it still lives in an env file rather than in source.

`npm run db:seed` creates **7 users** (1 Admin, 2 PMs, 4 Developers), 4 clients, 4 projects,
**24 tasks — 6 per project**, spread across all four statuses (7 To Do / 8 In Progress /
5 In Review / 4 Done) and all four priorities, **4 tasks already past their due date**, 8
project memberships, **89 backfilled activity events** and 30 notifications (most unread).
Nothing is empty on first load.

The seed then prints a table of every account with the number of feed events each one can see,
counted **through `activityScope()` itself** — the same filter the API and the socket layer
use. It is the fastest way to see the role boundaries before opening the app. Shown here after
the API has booted once, so the overdue sweep has added its 4 events (89 → 93):

```
  ROLE             EMAIL                 NAME            FEED   UNREAD
  ADMIN            priya@velozity.dev    Priya Sharma      93        0
  PROJECT_MANAGER  arjun@velozity.dev    Arjun Mehta       46        2
  PROJECT_MANAGER  neha@velozity.dev     Neha Kulkarni     47        3
  DEVELOPER        ravi@velozity.dev     Ravi Verma        22        5
  DEVELOPER        sana@velozity.dev     Sana Qureshi      21        3
  DEVELOPER        mei@velozity.dev      Mei Lin           18        6
  DEVELOPER        daniel@velozity.dev   Daniel Okoye      17        2
```

Two things in that table are worth a second look. **46 + 47 = 93** — the two managers' feeds
partition the agency exactly, with no overlap and nothing unaccounted for. And every developer
sees under a quarter of it, because their scope is their own assignments rather than their
projects.

> The seed deliberately leaves those 4 past-due tasks **unflagged**. The scheduler flags
> them — once at boot and every `OVERDUE_CRON` tick — which is how you can see that
> overdue state is computed by a background job and not derived on page load. Check the
> `Overdue` tile and the 4 `TASK_OVERDUE` rows that appear in the feed.

### Scripts

| Command | Does |
|---|---|
| `npm run dev` | API + web with hot reload |
| `npm run build` | Compiles both workspaces |
| `npm run typecheck` | `tsc --noEmit` over both (no `any`, no plain JS anywhere) |
| `npm test` | Vitest — 93 tests, see [Tests](#tests) |
| `npm run db:up` / `db:down` | Postgres container |
| `npm run db:migrate` / `db:seed` / `db:reset` | Prisma migrate, seed, reset |
| `npm run db:push` | Schema push without a migration, for throwaway experiments |
| `npm run db:studio` | Prisma Studio |

---

## What each role can do

Enforced in [`server/src/access/rbac.ts`](server/src/access/rbac.ts) — one module, imported
by every route. **✗ means the API refuses it**, not that a button is hidden.

| | Admin | Project Manager | Developer |
|---|:--:|:--:|:--:|
| Manage users | ✓ | ✗ | ✗ |
| Manage clients | ✓ | read only | ✗ |
| Create projects | ✓ | ✓ | ✗ |
| Edit / delete a project | ✓ | **own only** / ✗ | ✗ |
| Create & assign tasks | ✓ | own projects | ✗ |
| Change task status | ✓ | own projects | **assigned only**, not → Done |
| Change priority / assignee / due date | ✓ | own projects | ✗ |
| Activity feed | global | own projects | own tasks |
| Online-user presence | ✓ | ✗ | ✗ |

Two details worth calling out:

- **A developer's task scope is `assigneeId = me`, not "tasks in my projects."** Scoping by
  project would hand them every teammate's work, since they share a project by definition.
- **A developer cannot move a task to `Done`** — only to `In Review`. Without that gate the
  "moved to In Review" notification to the PM would be decorative, because a developer
  could self-approve.

### Out-of-scope rows return `404`, not `403`

A `403` confirms the id is real. Visibility is applied as a SQL `WHERE` fragment AND-ed into
every read, so a row you may not see is indistinguishable from a row that does not exist.

Copy-pasteable, against a running local API — Arjun and Neha are both Project Managers, and
project `…0004` ("Northwind Loyalty Programme") is Neha's:

```bash
API=http://localhost:4000/api
tok () { curl -s "$API/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$1@velozity.dev\",\"password\":\"Password123!\"}" \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'; }

ARJUN=$(tok arjun); NEHA=$(tok neha); RAVI=$(tok ravi)
P=33333333-3333-4333-8333-000000000004

code () { curl -s -o /dev/null -w '%{http_code}\n' "$@"; }

code "$API/projects/$P" -H "Authorization: Bearer $NEHA"     # 200 — hers
code "$API/projects/$P" -H "Authorization: Bearer $ARJUN"    # 404 — not 403
code "$API/users"       -H "Authorization: Bearer $RAVI"     # 403 — role gate
code "$API/projects/$P" -X PATCH -H "Authorization: Bearer $ARJUN" \
  -H 'content-type: application/json' -d '{"name":"Hijacked"}'   # 404, with a valid body
```

The last line matters: sending a *well-formed* body proves the `404` comes from the
authorisation scope and not from the validator rejecting the request first.

A handler never loads a row and *then* checks ownership. It asks the database only for rows
the principal is allowed to see.

---

## Architecture

```
┌─────────────────────────────── web (Vite · React 19 · TS) ───────────────────────────────┐
│  AuthProvider ─▶ SocketProvider ─▶ NotificationProvider ─▶ RouterProvider                │
│    access token          socket.io-client            unread count from     react-router  │
│    in a closure          transports:['websocket']    the socket, never     (innermost,   │
│    (never localStorage)                              polled                so navigation │
│                                                                            never drops   │
│                                                                            the socket)   │
└────────────┬──────────────────────────────────────────────┬──────────────────────────────┘
   REST ─ Bearer + HttpOnly cookie                  WebSocket ─ token in handshake
             ▼                                              ▼
┌─────────────────────────── server (Fastify 5 · Socket.IO 4 · TS) ────────────────────────┐
│  modules/{auth,users,clients,projects,tasks,activity,notifications,dashboard}            │
│      each a Fastify plugin with its own prefix + its own preHandler hooks                │
│                        │                                                                 │
│            access/rbac.ts  ◀── the single source of truth for visibility                 │
│                 │                                                                        │
│      ┌──────────┴────────────┐                                                           │
│      ▼                       ▼                                                           │
│  Prisma (SQL scopes)   realtime/fanout.ts  ── re-derives the SAME rule per socket        │
│                        realtime/presence.ts   jobs/overdue.job.ts (node-cron)            │
└──────────────────────────────────┬───────────────────────────────────────────────────────┘
                                   ▼
                        PostgreSQL 16 (relational, FK-enforced)
```

**Layering.** Routes validate (Zod) and authorise (preHandler), services hold the business
rules and own their transactions, Prisma is the only thing that talks SQL. No raw SQL in a
controller — the single `$queryRaw` is a liveness probe.

**One rule, two evaluators.** `rbac.ts` compiles visibility into Prisma `where` fragments for
REST. At socket emit time there is no query to filter, so `fanout.ts` re-derives the same rule
against the connected principal. Because that duplication is exactly where a leak would come
from, [`test/realtime.fanout.test.ts`](server/test/realtime.fanout.test.ts) asserts the two
agree for every (role, task) pair — and derives the expectation *from* `taskScope()` rather
than restating it, so editing one without the other fails the build.

---

## Database schema

9 tables and 6 enums, every relationship a real foreign key with a deliberate `onDelete`.
Full definition: [`server/prisma/schema.prisma`](server/prisma/schema.prisma).

```
Client ──1:N──▶ Project ──1:N──▶ Task ──1:N──▶ ActivityEvent
                   │ N:1           │ N:1(nullable)      │ N:1(nullable)
                   ▼               ▼                    ▼
              User (manager)  User (assignee)      User (actor)

User ──1:N──▶ RefreshToken        User ──1:N──▶ Notification
User ──1:1──▶ ActivityCursor      User ──N:M──▶ Project  (via ProjectMember)
```

| Table | Holds | Notes |
|---|---|---|
| `User` | People and their role | `role` is an enum; the principal is re-read from here on **every** request, so a role can never be asserted by a token claim |
| `Client` | Agency clients | `onDelete: Restrict` from `Project` — a client with projects cannot vanish |
| `Project` | Work for a client | `managerId` **is** the PM authorisation boundary |
| `ProjectMember` | Developers on a project | Composite PK `(projectId, userId)` — doubles as the uniqueness constraint and as the "who is on this project" index. Modelled as a table rather than inferred from task assignment, so team composition is stable even when a developer currently holds no tasks. |
| `Task` | The work | `number` is a global `autoincrement()` so the feed can say "Task #12"; `isOverdue` is a **stored** column written by the scheduler |
| `ActivityEvent` | Immutable audit log | `seq` is a global `autoincrement()` — see below |
| `ActivityCursor` | Per-user high-water mark | One row per user: `lastSeenSeq`. This is what makes catch-up survive a restart |
| `Notification` | In-app notifications | Addressed to one recipient; `readAt` nullable |

Three schema decisions carry real weight:

**1. `ActivityEvent` is written, never derived.** A status change writes a durable row inside
the same transaction as the task update. The feed is a `SELECT` from that table. Deriving
history from current task state would make it unreconstructable the moment a task changed
twice, and the audit trail would silently disappear if a task were reassigned.

**2. `seq`, a monotonic integer, rather than timestamps for catch-up.** `GET /activity/catchup`
returns events with `seq > lastSeenSeq`. Timestamps would be wrong here in two ways: clock
skew across instances can order two events inconsistently, and `createdAt > lastSeenAt` has a
real race at equal millisecond values — you either re-show an event or lose one. An integer
sequence has neither problem, and "how many did I miss" is arithmetic (`latestSeq - lastSeenSeq`)
rather than a second `COUNT`.

**3. `Task.isOverdue` is stored, not computed on read.** The brief requires a background job,
and there is a design reason beyond that: a computed flag produces no audit trail. The
scheduler writes a `TASK_OVERDUE` activity row and a notification when it flips the column, so
"when did this become late, and who was told" is answerable. It also keeps the admin overdue
tile a single indexed count rather than a predicate over every task.

### Index rationale

Each index exists for a query that actually runs; rationale is also inline in the schema.

| Index | Serves |
|---|---|
| `Task(assigneeId, status)` | **The most frequent query in the app** — a developer's dashboard is exactly this. |
| `Task(projectId, status)` | The project board, grouped into status columns. |
| `Task(status, dueDate)` | The overdue sweep: `status NOT IN (DONE) AND dueDate < now()`. Composite → range scan instead of a full table read. |
| `Task(projectId, priority)` | "Tasks by priority" tile and the shareable `?priority=` filter. |
| `Task(isOverdue)` | The admin overdue count, a low-cardinality flag lookup. |
| `ActivityEvent(seq DESC)` | Global admin feed, newest-first. |
| `ActivityEvent(projectId, seq DESC)` | PM and project-detail feeds. Also the catch-up range scan. |
| `ActivityEvent(taskId, seq DESC)` | Per-task history panel. |
| `ActivityEvent(actorId, seq DESC)` | "What has this person been doing" — the PM team view. |
| `Project(managerId, status)` | The hot path for every PM request: `WHERE managerId = $1`. `status` included because the list defaults to non-archived. |
| `Project(clientId)` | The client detail page, and the FK itself. |
| `Project(dueDate)` | Admin view of upcoming deadlines agency-wide. |
| `ProjectMember` PK `(projectId, userId)` | Composite primary key — uniqueness constraint and "who is on this project" index in one, no surrogate key. |
| `Client(isArchived, name)` | Client pickers and the admin client list — "active clients by name". |
| `Notification(recipientId, readAt)` | The unread badge: `recipientId = $1 AND readAt IS NULL`. Both columns are in the index, so the count needs no table access. |
| `Notification(recipientId, createdAt DESC)` | The dropdown list, newest-first. |
| `User(role, isActive)` | Admin user list and the assignee picker ("all active developers"). |
| `RefreshToken(userId, revokedAt)` | "Revoke every session for this user" on password change or deactivation. |
| `RefreshToken(familyId)` | Reuse detection revokes an entire token family in one statement. |
| `RefreshToken(expiresAt)` | Lets the cleanup job scan only rows that have actually expired. |

`email`, `Task.number`, `ActivityEvent.seq` and `RefreshToken.tokenHash` are `UNIQUE` —
constraints first, and the index comes free.

---

## Architectural decisions

### 1. Fastify over Express

Three reasons that bite in *this* app rather than benchmark trivia:

- **Encapsulation.** Each module is a plugin with its own prefix and its own hooks.
  `app.addHook('preHandler', app.authenticate)` inside `projects.routes.ts` applies to that
  subtree and nowhere else. Express middleware is positional and global by default — the exact
  shape that produces a forgotten guard on a route added six months later.
- **Async-native errors.** A rejected promise reaches `setErrorHandler` with no wrapper. In
  Express 4 an un-awaited rejection hangs the request, and the standard fix is hand-wrapping
  every route in `catchAsync`.
- **First-party security plugins.** helmet, cors, cookie and rate-limit are maintained with the
  framework and share its lifecycle.

The factory returns an app with no listener attached, which is what lets tests drive it via
`app.inject()` and lets `index.ts` hand the same HTTP server to Socket.IO.

### 2. Socket.IO over a bare `ws` server

This feature needs **rooms**, **reconnection with backoff**, **heartbeats** (presence is
derived from them) and **acknowledgements**. All four are hand-rolled boilerplate on native
WebSocket, and all four are load-bearing here — rooms in particular are the fanout primitive:

```
user:<id>      every socket of one person — the unit of role-filtered delivery
role:ADMIN     all admins, for the global feed and the presence tile
project:<id>   people currently viewing a project, for board updates
```

**The transport is pinned to `['websocket']` on both ends**, so there is no HTTP long-polling
fallback: connections are real WebSockets or they fail. That keeps Socket.IO's ergonomics
without the mechanism the brief rules out. The cost is a non-standard wire protocol — a raw
`ws` client cannot connect — which is acceptable for a first-party UI.

### 3. node-cron over Bull

Bull/BullMQ is a Redis-backed **queue**: the right tool when jobs are produced by request
handlers, need retries with backoff, or must be handed to a separate worker fleet. Nothing
here is like that. The only recurring work is one idempotent sweep on a fixed schedule.
Adding Redis to run it would introduce a second stateful dependency, a second failure mode,
and a deployment story with more moving parts than the feature justifies.

The trade-off, stated rather than hidden: node-cron has no cross-process lock, so every
instance runs the schedule. That is safe here because **the claim and the events it produces
happen in one transaction, and the claim re-checks `isOverdue: false` inside it**
(`updateManyAndReturn … WHERE isOverdue = false`). A second instance on the same cron minute
blocks on the row lock, re-evaluates the predicate after the first commits, and matches
nothing — the row being updated *is* the lock, so exactly-once needs no advisory lock and no
external queue. The sweep is batched at 200 tasks per run so a large backlog cannot hold locks
for minutes.

Two details in [`jobs/overdue.job.ts`](server/src/jobs/overdue.job.ts) worth knowing:

- **The sweep clears the flag as well as setting it.** A due date pushed into the future, or a
  task completed, must stop being overdue. That direction writes no activity event — it is a
  correction, not news — and it is what keeps a denormalised column trustworthy enough to
  index and count against.
- **Only the assignee is notified**, not the owning PM. The PM already sees the event in their
  feed and the count on their dashboard; a badge per late task across a whole portfolio is
  noise they would learn to ignore.

The point where node-cron stops being the right answer is when a job needs retry semantics or
a dead-letter path. Nothing here does.

### 4. Token storage: HttpOnly cookie + in-memory access token

| | Where | Lifetime | Reachable from JS |
|---|---|---|---|
| Refresh token | `HttpOnly; SameSite=Lax; Path=/api/auth` cookie | 7 days, **rotated on every use** | **No** |
| Access token | A module-scoped closure in `web/src/lib/api.ts` | 15 minutes | Only via the module |

Neither token is in `localStorage`. A token in `localStorage` is readable by any script on the
origin, which makes one XSS a persistent account takeover; the refresh token — the long-lived
one — is the one that must be unreachable, so it is the one in the cookie. The access token
lives in a closure and dies with the tab, and its 15-minute life bounds the damage if it leaks.

Three supporting details:

- **`Path=/api/auth`** — the cookie is scoped to the only three routes that need it
  (`/refresh`, `/logout`, `/login`), so it is not attached to every API request.
- **Rotation with reuse detection.** Each refresh issues a new token and revokes its
  predecessor, tracking a `familyId`. A replayed token revokes the whole family: a stolen
  cookie has a bounded useful life and using it locks out the thief *and* the victim, which is
  the correct failure direction.
- **Two different secrets** for access and refresh. If they were the same string, a refresh
  token would verify as an access token. That confusion is a test case, not a comment —
  see `access.integration.test.ts`.

The client wraps refresh in a **single-flight latch**: six components mounting at once produce
one refresh, not six. That is also what makes React's `StrictMode` double-invoked bootstrap
safe, which is why StrictMode is left on.

### 5. How the feed is role-filtered

The rule, stated once and applied everywhere:

> **An event reaches a socket only if that socket's principal would also have received it from
> the REST API.**

Two delivery strategies, chosen per event type:

**Addressed fanout** (`activity:new`, `notification:*`) — the authorised recipient set is
computed from the event itself (owning PM + assignee + actor + `role:ADMIN`) and emitted to
those rooms. Socket.IO de-duplicates a socket matching several rooms, so nobody gets doubles.
The *server* decides who is eligible; no client-side filtering is relied on for correctness.

**Filtered room walk** (`task:changed`) — board updates only interest people viewing that
project, so this starts from `project:<id>`. But **room membership means "is viewing", not "is
allowed to see"**, so it never calls `io.to(room).emit()`. It calls `fetchSockets()` and
re-checks each principal against the same predicate the database uses. Four people watching
one board get four different answers: the admin and owning PM see every card move, the
assignee sees their own, and a developer who is not the assignee sees nothing.

A second pass reaches the assignee and owning PM directly, because they may have the task open
in a dashboard rather than on the board — skipping anyone already served.

**Joining a room is itself authorised.** `project:subscribe` checks the requested project
against the caller's `projectScope()` before joining, and acknowledges with `{ ok: false }`
otherwise, so a client cannot subscribe its way into a project its role cannot see. That check
and the per-socket re-authorisation above are belt and braces on purpose: the subscribe gate
stops the socket joining, and the emit-time check means that even if it somehow were in the
room, it would still receive nothing.

Reassignment gets an explicit retraction (`emitTaskRemoved`): the previous assignee now *fails*
the visibility check, so the main fanout correctly skips them and their board would keep a
stale card forever. From their side the task genuinely is gone, so `changeKind: 'deleted'` is
the honest event.

**Offline catch-up is a database read, never a memory buffer.** `GET /api/activity/catchup`
returns up to 20 events with `seq > lastSeenSeq`, through the *same* `activityScope()` used by
the live path — so what you missed and what you would have seen are the same set. The cursor
is a table row, so it survives a restart and works across instances; an in-memory buffer would
lose it on deploy and give two instances different answers. **The newest 20 are returned**, not
the oldest — a user away for a week wants what just happened, not the first 20 things from
last Tuesday.

Sockets are also **force-disconnected on revocation** (`revokeUserSockets`). The handshake
check does not re-run on a live connection, so a socket authenticated 20 minutes ago would
otherwise keep streaming events after the account was deactivated.

---

## API reference

All routes are under `/api`. All require `Authorization: Bearer <access token>` except
`/auth/login` and `/auth/refresh` (which authenticates from the cookie alone).

Every request body, query string and route param is validated server-side with Zod before a
handler runs, and **every** failure — validation, authorisation, a missing route, a database
constraint, an unhandled bug — leaves through one envelope
([`plugins/error-handler.ts`](server/src/plugins/error-handler.ts)):

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [{ "path": "status", "message": "…" }] },
  "requestId": "01460eab-f5d1-41a7-9a47-b1b0bdd71416" }
```

**No stack trace, ORM message or SQL ever reaches the client.** An unhandled error is logged in
full server-side and returned as a generic 500 carrying only `requestId` — the handle needed to
find the real error in the logs. Known database failures are translated rather than swallowed,
so the status code stays meaningful instead of collapsing to 500:

| Prisma | HTTP | Meaning |
|---|---|---|
| `P2002` unique violation | `409` | "A record with that email already exists." The column name is our schema, so it is safe to name |
| `P2025` record not found | `404` | |
| `P2003` / `P2014` FK or relation violation | `409` | "That change would break a reference to another record." |
| anything else | `500` | Generic message, full detail to the log only |

In non-production the 500 message echoes `error.message` to make local debugging quicker. The
stack is never sent, in any environment.

| Method | Route | Notes |
|---|---|---|
| `POST` | `/auth/login` | Sets the HttpOnly refresh cookie; returns the access token in the body. Rate-limited to 10/min |
| `POST` | `/auth/refresh` | **Cookie only** — no Authorization header. Rotates the token. Rate-limited to 30/min |
| `POST` | `/auth/logout` | Revokes the token family and clears the cookie |
| `GET` | `/auth/me` | The principal, re-read from the database |
| `POST` | `/auth/change-password` | Revokes every other session |
| `GET`/`POST`/`PATCH` | `/users`, `/users/:id` | Admin only, via `requireRole(ADMIN)` |
| `GET`/`POST`/`PATCH`/`DELETE` | `/clients`, `/clients/:id` | Reads: Admin + PM. Writes: `requireRole(ADMIN)` |
| `GET`/`POST`/`PATCH` | `/projects`, `/projects/:id` | Reads scoped by `projectScope()`; writes `requireRole(ADMIN, PROJECT_MANAGER)` **and** an ownership check |
| `DELETE` | `/projects/:id` | Admin only — it destroys an audit trail |
| `GET` | `/projects/:id/activity` | Project feed, scoped |
| `GET`/`POST`/`DELETE` | `/projects/:id/members`, `/members/:userId` | Team composition; writes are Admin + owning PM |
| `GET`/`PATCH` | `/tasks`, `/tasks/:id` | Reads scoped by `taskScope()`; `PATCH` adds the per-role field allowlist |
| `POST`/`DELETE` | `/tasks`, `/tasks/:id` | `requireRole(ADMIN, PROJECT_MANAGER)` + project ownership |
| `GET` | `/tasks/:id/activity` | Per-task history, scoped |
| `GET` | `/activity` | Scoped by `activityScope()` |
| `GET` | `/activity/catchup` | Last ≤20 missed events, from the database |
| `POST` | `/activity/seen` | Advances `ActivityCursor.lastSeenSeq` |
| `GET`/`POST` | `/notifications`, `/:id/read`, `/read-all` | Recipient-scoped |
| `GET` | `/dashboard` | Returns one of three variants — **the server picks it from the principal** |

`GET /health` is the one route outside `/api` and outside auth: it reports status, uptime and
environment for a load balancer. It deliberately does **not** touch the database — a health
check that queries Postgres turns a slow database into an unhealthy-instance cascade. Database
reachability is verified once at boot instead (`src/index.ts`, the only hand-written
`$queryRaw` in the codebase).

Note the two layers on writes. `requireRole(...)` is a coarse gate that rejects a developer
posting to `/projects` outright; the ownership check inside the handler is what stops one PM
editing another's project. Either alone would be insufficient.

### Filters are query parameters, so a URL is shareable

```
/api/tasks?status=IN_REVIEW&priority=CRITICAL&dueFrom=2026-09-01&dueTo=2026-09-30&sort=priority&order=desc
```

`status`, `priority`, `assigneeId`, `projectId`, `overdue`, `dueFrom`, `dueTo`, `search`,
`sort`, `order`, `limit`, `cursor`. The frontend keeps these in the address bar, so
`/tasks?status=IN_REVIEW&priority=CRITICAL` pasted into Slack opens the same view for a
colleague — narrowed to what *their* role permits.

An unrecognised value is a **`400`, never silently ignored**. Dropping an unknown filter is the
dangerous failure: the caller believes they are looking at a narrowed list.

### Socket events

| Direction | Event | Payload |
|---|---|---|
| ▼ server | `activity:new` | One feed event |
| ▼ server | `task:changed` | `{ …task, changeKind: 'created' \| 'updated' \| 'deleted' }` |
| ▼ server | `notification:new` / `notification:count` | The row / `{ unread }` — **pushed, never polled** |
| ▼ server | `presence:update` | `{ onlineCount, users[] }` — admins only |
| ▼ server | `session:revoked` | `{ reason }`, then the socket is closed |
| ▲ client | `project:subscribe` / `project:unsubscribe` | Room membership for the board being viewed (acknowledged, so the client knows the join landed) |
| ▲ client | `activity:seen` | Advances the durable cursor |

---

## Deployment

The two halves deploy to different places, and the reason is architectural rather than
incidental: **a Socket.IO server holds long-lived connections and in-process room state, which
a serverless function cannot do.** Vercel's runtime is request-scoped, so putting the API there
would mean dropping the WebSocket requirement — which the brief rules out. So:

| Half | Host | Why |
|---|---|---|
| `web/` — the SPA | **Vercel** (`web/vercel.json` is ready: Vite preset, SPA rewrite, immutable asset caching, security headers) | Static output, global CDN |
| `server/` — API + Socket.IO | Any persistent Node host (Railway, Render, Fly.io) via `server/Dockerfile` | Needs a process that stays alive and holds sockets |
| PostgreSQL | Managed (Neon, Supabase, Railway) | — |

Once the API is on a different origin from the SPA, the refresh cookie becomes cross-site and
three settings have to agree or **login will appear to work and then silently fail to refresh**:

```bash
# web (Vercel env)
VITE_API_URL=https://your-api.example.com

# server
CORS_ORIGINS=https://your-app.vercel.app   # exact origin, credentials mode requires it
COOKIE_CROSS_SITE=true                     # → SameSite=None; Secure
COOKIE_DOMAIN=                             # leave blank unless API and SPA share a parent domain
```

`COOKIE_CROSS_SITE=true` switches the cookie to `SameSite=None; Secure`, which browsers only
accept over HTTPS — so this cannot be tested over plain `http://`. Locally none of it is needed,
because the Vite dev server proxies `/api` and `/socket.io` and the browser stays same-origin.

Run migrations against the managed database before first boot (`npm run db:migrate --workspace
server`, then `db:seed`), or let the container do it with `RUN_MIGRATIONS_ON_BOOT=true` and
`SEED_ON_BOOT=true`.

---

## Tests

```bash
npm test        # 93 tests, 3 files
```

Three tiers, deliberately:

| File | Tier | Covers |
|---|---|---|
| [`test/rbac.test.ts`](server/test/rbac.test.ts) | Pure | Every rule in `rbac.ts`. Asserts the *shape* of each Prisma fragment — a scope that accidentally widened to `{}` is still a truthy object, so only comparing the fragment catches it. |
| [`test/realtime.fanout.test.ts`](server/test/realtime.fanout.test.ts) | Pure | Parity between the socket predicate and the SQL scope for every (role, task) pair, plus re-authorisation of each board viewer through a fake Socket.IO server. |
| [`test/access.integration.test.ts`](server/test/access.integration.test.ts) | Integration | The real app via `app.inject()` against the real database. Forged tokens (tampered role, swapped subject, `alg: none`, attacker-signed, cross-secret, expired), 404-not-403 scoping, the developer→`Done` gate, cookie flags, refresh rotation. |

The integration tier needs a seeded database and **skips with a console note** if Postgres is
unreachable, so `npm test` on a fresh clone still runs the pure tiers.

The split is the point: `rbac.test.ts` proves the rules are right; only the integration tier
proves the handlers *apply* them. A handler that forgot to AND in its scope would pass every
unit test in the file.

---

## Known limitations

Honest list, roughly by how much they would matter next.

1. **`web/src/types/api.ts` is hand-mirrored from the server's Zod schemas.** Compile-time
   safety on both sides, but nothing enforces that they agree. Generating the client types from
   the schemas (or sharing a `packages/contracts` workspace) is the fix, and is the first thing
   I would add.
2. **`useApiQuery` is not a query cache.** It de-duplicates in-flight requests and refetches on
   relevant socket events, but there is no shared normalised store, so two mounted components
   asking for the same resource fetch twice. Deliberate — TanStack Query would have solved it,
   and writing the state decisions out explicitly was the point of the exercise.
3. **Dashboard tiles refetch rather than patch.** An overdue count cannot be recomputed from a
   single task event without re-deriving the scheduler's logic client-side, so a relevant event
   triggers a debounced re-read. Correct, but chattier than a server-computed delta.
4. **Socket.IO is single-node.** Rooms live in one process's memory; horizontal scaling needs
   `@socket.io/redis-adapter`. The REST tier is already stateless, and `presence` is the only
   in-memory state.
5. **node-cron has no distributed lock.** Safe today because the sweep claims work atomically
   (§3), but a future job with side effects outside Postgres would need one.
6. **`password` validation is mirrored in two places** — `server/src/modules/auth/auth.schemas.ts`
   and `web/src/lib/validation.ts`. Same root cause as (1).
7. **No pagination on the project list.** Fine at agency scale (tens of projects); tasks and
   activity are both cursor-paginated.
8. **Presence is per-socket, not per-user-session.** Two browser tabs are one user in the count
   but two heartbeats; a tab crash leaves a ghost until the heartbeat times out.
9. **Root `overrides: { "vite": "^7.3.6" }`.** `vitest@5` pulls in rolldown-based `vite@8` as a
   peer, which drops `build.rollupOptions.output.manualChunks` — the vendor chunk split this
   build relies on. Two vite copies in one tree also make `@vitejs/plugin-react`'s `Plugin`
   type incompatible with `defineConfig`'s. Pinning to 7 is the smaller cost; vitest 5's peer
   range already allows it. JSON cannot carry a comment, hence this note.
10. **No E2E browser test.** The role boundaries are covered at the API level, which is where
    they are enforced; the React tree is covered by `tsc` and by hand.

---

## Explanation

The hardest problem was not the WebSocket layer — it was that **role-based visibility has to be
expressed twice, in two languages, and the two must never disagree.** For REST, `rbac.ts`
compiles each role into a Prisma `where` fragment that is AND-ed into every read, so a handler
asks the database only for rows the principal may see. At socket emit time there is no query to
filter: an event exists and I have to decide who gets it. That forced a second, in-memory
evaluator — and two implementations of one security rule is precisely where a leak comes from.

I handled the real-time feed by never broadcasting to a room. Room membership means "is
currently viewing", not "is allowed to see", so `task:changed` fetches the sockets in a project
room and re-checks each principal against the same predicate the SQL scope uses. Four people
watching one board get four different answers. To stop the two evaluators drifting, the fanout
test derives its expectations *from* `taskScope()` rather than restating them, so changing one
without the other fails the build. Offline catch-up reads the database through that same scope,
ordered by a monotonic `seq` rather than timestamps — clock skew and equal-millisecond ties
both silently lose or duplicate events.

What I would do differently: generate the client types from the Zod schemas instead of
hand-mirroring them in `web/src/types/api.ts`. It is the one place in the project where
correctness rests on discipline rather than on the compiler.

---

## Licence

Written as a technical assessment for Velozity Global Solutions.
