/**
 * Deterministic development fixture.
 *
 *   npm run db:seed          # explicit
 *   npm run db:reset         # migrate reset --force, which runs this afterwards
 *
 * Four properties this script is built around:
 *
 *   1. **The history is synthesised, not sprinkled.** Every activity event and
 *      every notification is *derived* from the same task fixtures as the task
 *      rows, by walking each task's status history in chronological order. The
 *      seeded audit log therefore cannot contradict the seeded task state —
 *      which is the exact class of detail that makes a demo feed look fake
 *      ("Ravi moved Task #7 to Done" next to a task sitting in To Do).
 *
 *   2. **Dates are relative to run time.** "Overdue" and "due this week" have to
 *      still be true next month, so there is not a single absolute date below.
 *
 *   3. **`isOverdue` is deliberately left `false`.** The brief requires the
 *      overdue flag to come from a scheduled job rather than a page load, so the
 *      fixture leaves four tasks genuinely past their due date and *unflagged*.
 *      The sweep in src/jobs/overdue.job.ts claims them on API boot, writes the
 *      activity events and notifies the assignees — so the feature can be
 *      watched working rather than taken on trust from a seeded column.
 *
 *   4. **Every role has something to see.** The fixture is arranged so that each
 *      of the seven accounts has a non-empty activity feed, a non-empty task
 *      list where the role has one, and unseen events waiting on first connect.
 *      The summary printed at the end proves it by counting through the same
 *      `activityScope()` the API uses, rather than by assertion.
 *
 * Console output rather than the pino logger: this is a CLI script whose output
 * is read by a person once, not a log stream anyone will ever query.
 */
import {
  prisma,
  Prisma,
  Role,
  ProjectStatus,
  TaskStatus,
  TaskPriority,
  type ActivityType,
  type NotificationType,
} from '../src/db/client.js';
import { env } from '../src/config/env.js';
import { hashPassword } from '../src/lib/password.js';
import { activityScope, type Principal } from '../src/access/rbac.js';

/* ------------------------------------------------------------------ *
 * Time helpers — one `NOW` for the whole run, so a slow seed cannot
 * produce a task created after an event that describes its creation.
 * ------------------------------------------------------------------ */

const NOW = new Date();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR);
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);
const minutesAfter = (base: Date, minutes: number): Date => new Date(base.getTime() + minutes * 60_000);

/** Deadlines land at 18:00 local, the way a human would set one. */
const dueIn = (days: number): Date => {
  const date = new Date(NOW.getTime() + days * DAY);
  date.setHours(18, 0, 0, 0);
  return date;
};

/**
 * Everything older than this is treated as "already read" by the fixture.
 *
 * The point is a realistic mix: an inbox where every notification is unread
 * looks broken, and one where none are shows nothing.
 */
const READ_AFTER_DAYS = 14;

/**
 * Events older than this are marked as already seen, so every account starts
 * with a small, plausible backlog.
 *
 * This is what makes the "last 20 events you missed" requirement demonstrable on
 * first login: the `ActivityCursor` high-water mark is seeded to the newest event
 * older than the cutoff, and the six most recent events are arranged to touch all
 * four projects, both managers and all four developers — so *no* account starts
 * with an empty catch-up.
 */
const UNSEEN_WINDOW_HOURS = 8;

/* ------------------------------------------------------------------ *
 * Identity of the fixture rows
 *
 * Fixed UUIDs rather than generated ones, so a project URL a reviewer
 * bookmarked still resolves after a re-seed, and so the README can point at a
 * specific record. Version/variant nibbles are set correctly (…-4xxx-8xxx-…)
 * because route params are validated with `z.uuid()`, which checks them.
 * ------------------------------------------------------------------ */

const userId = (n: number): string => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const clientId = (n: number): string => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const projectId = (n: number): string => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const taskId = (n: number): string => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

/* ------------------------------------------------------------------ *
 * People
 * ------------------------------------------------------------------ */

interface UserSeed {
  id: string;
  email: string;
  name: string;
  role: Role;
  jobTitle: string;
  avatarColor: string;
  joinedDaysAgo: number;
}

const USERS = {
  priya: {
    id: userId(1),
    email: 'priya@velozity.dev',
    name: 'Priya Sharma',
    role: Role.ADMIN,
    jobTitle: 'Operations Director',
    avatarColor: '#7c3aed',
    joinedDaysAgo: 420,
  },
  arjun: {
    id: userId(2),
    email: 'arjun@velozity.dev',
    name: 'Arjun Mehta',
    role: Role.PROJECT_MANAGER,
    jobTitle: 'Senior Project Manager',
    avatarColor: '#0ea5e9',
    joinedDaysAgo: 310,
  },
  neha: {
    id: userId(3),
    email: 'neha@velozity.dev',
    name: 'Neha Kulkarni',
    role: Role.PROJECT_MANAGER,
    jobTitle: 'Project Manager',
    avatarColor: '#f97316',
    joinedDaysAgo: 260,
  },
  ravi: {
    id: userId(4),
    email: 'ravi@velozity.dev',
    name: 'Ravi Verma',
    role: Role.DEVELOPER,
    jobTitle: 'Frontend Engineer',
    avatarColor: '#22c55e',
    joinedDaysAgo: 240,
  },
  sana: {
    id: userId(5),
    email: 'sana@velozity.dev',
    name: 'Sana Qureshi',
    role: Role.DEVELOPER,
    jobTitle: 'Backend Engineer',
    avatarColor: '#e11d48',
    joinedDaysAgo: 205,
  },
  daniel: {
    id: userId(6),
    email: 'daniel@velozity.dev',
    name: 'Daniel Okoye',
    role: Role.DEVELOPER,
    jobTitle: 'Full-stack Engineer',
    avatarColor: '#6366f1',
    joinedDaysAgo: 150,
  },
  mei: {
    id: userId(7),
    email: 'mei@velozity.dev',
    name: 'Mei Lin',
    role: Role.DEVELOPER,
    jobTitle: 'QA Engineer',
    avatarColor: '#14b8a6',
    joinedDaysAgo: 95,
  },
} satisfies Record<string, UserSeed>;

type UserKey = keyof typeof USERS;
type ManagerKey = 'arjun' | 'neha';
type DeveloperKey = 'ravi' | 'sana' | 'daniel' | 'mei';

/* ------------------------------------------------------------------ *
 * Clients
 * ------------------------------------------------------------------ */

interface ClientSeed {
  id: string;
  name: string;
  company: string;
  contactName: string;
  contactEmail: string;
  isArchived: boolean;
  createdDaysAgo: number;
}

const CLIENTS = {
  northwind: {
    id: clientId(1),
    name: 'Northwind Retail',
    company: 'Northwind Retail Group Ltd',
    contactName: 'Helen Boyd',
    contactEmail: 'helen.boyd@northwind-retail.example',
    isArchived: false,
    createdDaysAgo: 180,
  },
  lumen: {
    id: clientId(2),
    name: 'Lumen Health',
    company: 'Lumen Health Partners',
    contactName: 'Dr Anil Rao',
    contactEmail: 'a.rao@lumenhealth.example',
    isArchived: false,
    createdDaysAgo: 120,
  },
  kestrel: {
    id: clientId(3),
    name: 'Kestrel Logistics',
    company: 'Kestrel Logistics BV',
    contactName: 'Marta Nowak',
    contactEmail: 'm.nowak@kestrel-logistics.example',
    isArchived: false,
    createdDaysAgo: 75,
  },
  /**
   * A finished engagement, kept to exercise `?includeArchived=true` and the
   * "cannot archive a client with active projects" rule — it deliberately has
   * no projects, which is the only state in which archiving is allowed.
   */
  orchard: {
    id: clientId(4),
    name: 'Orchard & Vine',
    company: 'Orchard & Vine Wines',
    contactName: 'Tom Ellery',
    contactEmail: 'tom@orchardandvine.example',
    isArchived: true,
    createdDaysAgo: 300,
  },
} satisfies Record<string, ClientSeed>;

type ClientKey = keyof typeof CLIENTS;

/* ------------------------------------------------------------------ *
 * Projects and tasks
 * ------------------------------------------------------------------ */

/** One step of a task's status walk. The last step is the task's current status. */
interface StatusMove {
  to: TaskStatus;
  hoursAgo: number;
}

interface TaskSeed {
  title: string;
  description: string;
  assignee: DeveloperKey | null;
  priority: TaskPriority;
  createdHoursAgo: number;
  /** Days from now. Negative means already past — i.e. genuinely overdue. */
  dueInDays: number | null;
  /** Chronological status walk starting from TODO. Omit for a task still in To Do. */
  moves?: readonly StatusMove[];
  /** Optional edits, so the feed exercises every event renderer, not just status. */
  priorityRaisedFrom?: { from: TaskPriority; hoursAgo: number };
  dueDateMovedFrom?: { fromDays: number; hoursAgo: number };
}

interface ProjectSeed {
  id: string;
  name: string;
  description: string;
  clientKey: ClientKey;
  managerKey: ManagerKey;
  status: ProjectStatus;
  createdDaysAgo: number;
  startInDays: number;
  dueInDays: number;
  members: readonly DeveloperKey[];
  tasks: readonly TaskSeed[];
}

/**
 * Note the shape of the portfolio, which is chosen to make the access rules
 * falsifiable rather than merely plausible:
 *
 *   - Northwind is the client of **two** projects owned by **different**
 *     managers. So the client list's `projectCount` must read 1 for Arjun, 1 for
 *     Neha and 2 for the admin. An unscoped count would be visibly wrong here,
 *     which is the point.
 *   - Every developer sits on exactly two projects, and the two managers' teams
 *     overlap (Daniel works for both, Ravi and Mei for both). So "a PM sees
 *     their team's activity" cannot be satisfied by accidentally showing
 *     everything, and a developer's feed cannot be satisfied by showing their
 *     project's events — Daniel would see Sana's work.
 *   - Each project has one unassigned task, so `?unassigned=true` returns
 *     something for a manager triaging a backlog.
 */
const PROJECTS: readonly ProjectSeed[] = [
  {
    id: projectId(1),
    name: 'Northwind Storefront Replatform',
    description:
      'Rebuild the Northwind storefront on the new component library, with server-rendered listing pages and a Stripe checkout.',
    clientKey: 'northwind',
    managerKey: 'arjun',
    status: ProjectStatus.ACTIVE,
    createdDaysAgo: 34,
    startInDays: -30,
    dueInDays: 26,
    members: ['ravi', 'sana'],
    tasks: [
      {
        title: 'Extract design tokens from the existing storefront',
        description:
          'Audit the current CSS, pull colour, spacing and type scales into tokens, and document the mapping to the new library.',
        assignee: 'ravi',
        priority: TaskPriority.HIGH,
        createdHoursAgo: 26 * 24,
        dueInDays: -4, // overdue #1
        moves: [
          { to: TaskStatus.IN_PROGRESS, hoursAgo: 22 * 24 },
          { to: TaskStatus.IN_REVIEW, hoursAgo: 3 },
        ],
      },
      {
        title: 'Product listing page: server-side rendering',
        description: 'Move the listing page to SSR so category pages are indexable and the first paint does not wait on JSON.',
        assignee: 'sana',
        priority: TaskPriority.CRITICAL,
        createdHoursAgo: 24 * 24,
        dueInDays: 2,
        moves: [{ to: TaskStatus.IN_PROGRESS, hoursAgo: 6 }],
        priorityRaisedFrom: { from: TaskPriority.HIGH, hoursAgo: 7 * 24 },
      },
      {
        title: 'Cart persistence across sessions',
        description: 'Keep a guest cart for 30 days and merge it into the account cart on sign-in.',
        assignee: 'ravi',
        priority: TaskPriority.MEDIUM,
        createdHoursAgo: 20 * 24,
        dueInDays: 5,
      },
      {
        title: 'Migrate legacy checkout to Stripe Elements',
        description: 'Replace the hosted redirect with embedded Elements, including 3DS and the saved-card flow.',
        assignee: 'sana',
        priority: TaskPriority.CRITICAL,
        createdHoursAgo: 30 * 24,
        dueInDays: 9,
        moves: [
          { to: TaskStatus.IN_PROGRESS, hoursAgo: 25 * 24 },
          { to: TaskStatus.IN_REVIEW, hoursAgo: 10 * 24 },
          { to: TaskStatus.DONE, hoursAgo: 8 * 24 },
        ],
      },
      {
        title: 'Accessibility pass on the category filters',
        description: 'Keyboard traversal, focus return on panel close, and announced result counts.',
        assignee: 'ravi',
        priority: TaskPriority.LOW,
        createdHoursAgo: 12 * 24,
        dueInDays: 12,
        moves: [{ to: TaskStatus.IN_PROGRESS, hoursAgo: 40 }],
      },
      {
        title: 'Image CDN cutover plan',
        description: 'Write the cutover and rollback plan for moving product imagery behind the new CDN.',
        assignee: null,
        priority: TaskPriority.MEDIUM,
        createdHoursAgo: 5 * 24,
        dueInDays: 14,
      },
    ],
  },
  {
    id: projectId(2),
    name: 'Lumen Patient Portal',
    description: 'Patient-facing portal for appointments, lab results and consent, integrated with the existing HL7 feed.',
    clientKey: 'lumen',
    managerKey: 'arjun',
    status: ProjectStatus.ACTIVE,
    createdDaysAgo: 29,
    startInDays: -26,
    dueInDays: 40,
    members: ['sana', 'daniel'],
    tasks: [
      {
        title: 'Appointment booking flow',
        description: 'Slot search, hold, confirm and cancel, with the clinic calendar as the source of truth.',
        assignee: 'daniel',
        priority: TaskPriority.HIGH,
        createdHoursAgo: 18 * 24,
        dueInDays: 3,
        moves: [
          { to: TaskStatus.IN_PROGRESS, hoursAgo: 14 * 24 },
          { to: TaskStatus.IN_REVIEW, hoursAgo: 5 },
        ],
      },
      {
        title: 'HL7 message parser for lab results',
        description: 'Parse ORU^R01 messages into the results model, quarantining anything that fails validation.',
        assignee: 'sana',
        priority: TaskPriority.CRITICAL,
        createdHoursAgo: 22 * 24,
        dueInDays: -1, // overdue #2
        moves: [{ to: TaskStatus.IN_PROGRESS, hoursAgo: 16 * 24 }],
      },
      {
        title: 'Consent capture and audit trail',
        description: 'Record consent grants and withdrawals as immutable events with the acting user and timestamp.',
        assignee: 'daniel',
        priority: TaskPriority.HIGH,
        createdHoursAgo: 15 * 24,
        dueInDays: 6,
      },
      {
        title: 'Session timeout and re-authentication prompt',
        description: 'Idle timeout with a warning dialog, and silent refresh while the tab is active.',
        assignee: 'sana',
        priority: TaskPriority.MEDIUM,
        createdHoursAgo: 28 * 24,
        dueInDays: 1,
        moves: [
          { to: TaskStatus.IN_PROGRESS, hoursAgo: 24 * 24 },
          { to: TaskStatus.IN_REVIEW, hoursAgo: 20 * 24 },
          { to: TaskStatus.DONE, hoursAgo: 19 * 24 },
        ],
      },
      {
        title: 'Portal onboarding email templates',
        description: 'Welcome, verify-email and first-appointment templates, plain-text fallbacks included.',
        assignee: 'daniel',
        priority: TaskPriority.LOW,
        createdHoursAgo: 9 * 24,
        dueInDays: null,
      },
      {
        title: 'Load test the results endpoint',
        description: 'Establish a baseline at 200 concurrent patients and record p95 against the HL7 mock.',
        assignee: 'sana',
        priority: TaskPriority.MEDIUM,
        createdHoursAgo: 7 * 24,
        dueInDays: 8,
        moves: [{ to: TaskStatus.IN_PROGRESS, hoursAgo: 30 }],
      },
    ],
  },
  {
    id: projectId(3),
    name: 'Kestrel Fleet Tracker',
    description: 'Live fleet tracking with geofence alerting and driver-hours compliance reporting.',
    clientKey: 'kestrel',
    managerKey: 'neha',
    status: ProjectStatus.ACTIVE,
    createdDaysAgo: 27,
    startInDays: -24,
    dueInDays: 33,
    members: ['daniel', 'mei'],
    tasks: [
      {
        title: 'Live vehicle position stream',
        description: 'Consume the telematics websocket feed and fan positions out to subscribed map clients.',
        assignee: 'daniel',
        priority: TaskPriority.CRITICAL,
        createdHoursAgo: 19 * 24,
        dueInDays: 4,
        moves: [
          { to: TaskStatus.IN_PROGRESS, hoursAgo: 15 * 24 },
          { to: TaskStatus.IN_REVIEW, hoursAgo: 7 },
        ],
      },
      {
        title: 'Geofence breach alerts',
        description: 'Evaluate polygon entry and exit per position update, with debouncing on the depot boundary.',
        assignee: 'mei',
        priority: TaskPriority.HIGH,
        createdHoursAgo: 17 * 24,
        dueInDays: -6, // overdue #3
        moves: [{ to: TaskStatus.IN_PROGRESS, hoursAgo: 11 * 24 }],
        dueDateMovedFrom: { fromDays: -12, hoursAgo: 12 * 24 },
      },
      {
        title: 'Driver hours compliance report',
        description: 'Weekly per-driver hours against the regulatory limit, exportable as CSV.',
        assignee: 'mei',
        priority: TaskPriority.MEDIUM,
        createdHoursAgo: 13 * 24,
        dueInDays: 7,
      },
      {
        title: 'Offline map tile caching',
        description: 'Cache tiles for the depot regions so the driver app stays usable without signal.',
        assignee: 'daniel',
        priority: TaskPriority.HIGH,
        createdHoursAgo: 25 * 24,
        dueInDays: 10,
        moves: [
          { to: TaskStatus.IN_PROGRESS, hoursAgo: 21 * 24 },
          { to: TaskStatus.IN_REVIEW, hoursAgo: 15 * 24 },
          { to: TaskStatus.DONE, hoursAgo: 13 * 24 },
        ],
      },
      {
        title: 'Regression suite for the tracking API',
        description: 'Contract tests over the position, geofence and report endpoints, wired into CI.',
        assignee: 'mei',
        priority: TaskPriority.MEDIUM,
        createdHoursAgo: 6 * 24,
        dueInDays: 2,
        moves: [{ to: TaskStatus.IN_PROGRESS, hoursAgo: 20 }],
      },
      {
        title: 'Telematics vendor spike',
        description: 'Compare the two candidate vendor SDKs on reconnect behaviour and message ordering.',
        assignee: null,
        priority: TaskPriority.LOW,
        createdHoursAgo: 4 * 24,
        dueInDays: null,
      },
    ],
  },
  {
    id: projectId(4),
    name: 'Northwind Loyalty Programme',
    description: 'Points ledger, tier rules and reward redemption for Northwind, paused pending a legal review.',
    clientKey: 'northwind',
    managerKey: 'neha',
    status: ProjectStatus.ON_HOLD,
    createdDaysAgo: 18,
    startInDays: -16,
    dueInDays: 55,
    members: ['ravi', 'mei'],
    tasks: [
      {
        title: 'Points ledger schema',
        description: 'Append-only ledger with balance projections, so a balance can always be explained by its entries.',
        assignee: 'ravi',
        priority: TaskPriority.HIGH,
        createdHoursAgo: 16 * 24,
        dueInDays: 6,
        moves: [
          { to: TaskStatus.IN_PROGRESS, hoursAgo: 12 * 24 },
          { to: TaskStatus.IN_REVIEW, hoursAgo: 9 * 24 },
          { to: TaskStatus.DONE, hoursAgo: 8 * 24 },
        ],
      },
      {
        title: 'Tier calculation rules engine',
        description: 'Evaluate tier movement on a rolling 12-month window, with a dry-run mode for the marketing team.',
        assignee: 'mei',
        priority: TaskPriority.MEDIUM,
        createdHoursAgo: 14 * 24,
        dueInDays: -2, // overdue #4
        moves: [{ to: TaskStatus.IN_PROGRESS, hoursAgo: 9 * 24 }],
        priorityRaisedFrom: { from: TaskPriority.LOW, hoursAgo: 5 * 24 },
      },
      {
        title: 'Reward redemption API',
        description: 'Reserve, confirm and release redemptions, with idempotency keys on the confirm call.',
        assignee: 'ravi',
        priority: TaskPriority.MEDIUM,
        createdHoursAgo: 10 * 24,
        dueInDays: 11,
      },
      {
        title: 'Loyalty dashboard wireframes',
        description: 'Low-fidelity wireframes for the member-facing balance and tier progress views.',
        assignee: 'mei',
        priority: TaskPriority.LOW,
        createdHoursAgo: 8 * 24,
        dueInDays: 4,
        moves: [{ to: TaskStatus.IN_PROGRESS, hoursAgo: 4 }],
      },
      {
        title: 'Fraud rules for point transfers',
        description: 'Velocity and relationship checks before a member-to-member transfer is accepted.',
        assignee: null,
        priority: TaskPriority.HIGH,
        createdHoursAgo: 3 * 24,
        dueInDays: 13,
      },
      {
        title: 'Email opt-in migration',
        description: 'Backfill marketing consent from the legacy list, defaulting to opted-out where unknown.',
        assignee: 'ravi',
        priority: TaskPriority.LOW,
        createdHoursAgo: 11 * 24,
        dueInDays: 1,
        moves: [
          { to: TaskStatus.IN_PROGRESS, hoursAgo: 50 },
          { to: TaskStatus.IN_REVIEW, hoursAgo: 2 },
        ],
      },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Derived shapes
 * ------------------------------------------------------------------ */

/** A task after its fixture has been resolved against `NOW`. */
interface ResolvedTask {
  id: string;
  number: number;
  seed: TaskSeed;
  project: ProjectSeed;
  managerId: string;
  managerName: string;
  assigneeId: string | null;
  assigneeName: string | null;
  createdAt: Date;
  updatedAt: Date;
  dueDate: Date | null;
  status: TaskStatus;
  completedAt: Date | null;
}

/** An activity row waiting to be written, ordered by `at` before insertion. */
interface PendingEvent {
  at: Date;
  type: ActivityType;
  projectId: string;
  projectName: string;
  taskId: string | null;
  taskNumber: number | null;
  taskTitle: string | null;
  actorId: string;
  actorName: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  metadata: Prisma.InputJsonValue | null;
}

interface PendingNotification {
  at: Date;
  recipientId: string;
  actorId: string;
  type: NotificationType;
  title: string;
  body: string;
  taskId: string;
  projectId: string;
}

const finalStatus = (seed: TaskSeed): TaskStatus => seed.moves?.at(-1)?.to ?? TaskStatus.TODO;

const lastTouched = (seed: TaskSeed, createdAt: Date): Date => {
  const stamps = [
    createdAt,
    ...(seed.moves ?? []).map((move) => hoursAgo(move.hoursAgo)),
    ...(seed.priorityRaisedFrom ? [hoursAgo(seed.priorityRaisedFrom.hoursAgo)] : []),
    ...(seed.dueDateMovedFrom ? [hoursAgo(seed.dueDateMovedFrom.hoursAgo)] : []),
  ];
  return new Date(Math.max(...stamps.map((date) => date.getTime())));
};

/**
 * Who performed a status move.
 *
 * A developer may push work as far as In Review but not sign it off — see
 * `DEVELOPER_FORBIDDEN_STATUSES` in src/access/rbac.ts. So the actor on a move
 * to Done is the owning manager, and the fixture's history is a history the
 * application's own rules would have permitted.
 */
const moveActor = (task: ResolvedTask, to: TaskStatus): { id: string; name: string } =>
  to === TaskStatus.DONE || task.assigneeId === null
    ? { id: task.managerId, name: task.managerName }
    : { id: task.assigneeId, name: task.assigneeName ?? task.managerName };

const readAtFor = (createdAt: Date): Date | null =>
  createdAt.getTime() < daysAgo(READ_AFTER_DAYS).getTime() ? minutesAfter(createdAt, 90) : null;

/* ------------------------------------------------------------------ *
 * Reset
 * ------------------------------------------------------------------ */

/**
 * Rebuild rather than upsert.
 *
 * The fixture's value is that its activity log, notifications and task state are
 * consistent with each other. Upserting into a database somebody has since
 * clicked around in produces a state that has never been tested — a feed
 * describing transitions that no longer match the rows. Deleting first is the
 * honest option, and it is what makes the printed summary trustworthy.
 *
 * Order matters where a foreign key is `Restrict` (Project → Client, Project →
 * manager). The cascades would handle the rest, but being explicit keeps the
 * dependency order readable.
 */
const resetDomainData = async (tx: Prisma.TransactionClient): Promise<void> => {
  await tx.notification.deleteMany({});
  await tx.activityEvent.deleteMany({});
  await tx.activityCursor.deleteMany({});
  // Sessions must go too: a refresh cookie minted against a user id that is
  // about to be deleted and recreated would otherwise look valid but resolve to
  // nothing, which is a confusing way to start a demo.
  await tx.refreshToken.deleteMany({});
  await tx.task.deleteMany({});
  await tx.projectMember.deleteMany({});
  await tx.project.deleteMany({});
  await tx.client.deleteMany({});
  await tx.user.deleteMany({});

  // `Task.number` is the human-facing id the UI renders as "Task #12". It is a
  // Postgres sequence, and deleting rows does not rewind it — so without this a
  // second seed would produce tasks #25-48 and every reference to a task number
  // in the README would rot. Constant SQL, no interpolation.
  await tx.$executeRawUnsafe('ALTER SEQUENCE "Task_number_seq" RESTART WITH 1');
  await tx.$executeRawUnsafe('ALTER SEQUENCE "ActivityEvent_seq_seq" RESTART WITH 1');
};

/* ------------------------------------------------------------------ *
 * Insert
 * ------------------------------------------------------------------ */

const seedUsers = async (tx: Prisma.TransactionClient): Promise<void> => {
  // Hashed per user rather than once and reused: seven rows sharing a single
  // bcrypt digest would work, but a password store where identical passwords
  // produce identical hashes is exactly the thing salting exists to prevent, and
  // a fixture is a poor place to demonstrate the opposite.
  const rows = await Promise.all(
    Object.values(USERS).map(async (user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      jobTitle: user.jobTitle,
      avatarColor: user.avatarColor,
      passwordHash: await hashPassword(env.SEED_PASSWORD),
      createdAt: daysAgo(user.joinedDaysAgo),
      updatedAt: daysAgo(user.joinedDaysAgo),
    })),
  );

  await tx.user.createMany({ data: rows });
};

const seedClients = async (tx: Prisma.TransactionClient): Promise<void> => {
  await tx.client.createMany({
    data: Object.values(CLIENTS).map((client) => ({
      id: client.id,
      name: client.name,
      company: client.company,
      contactName: client.contactName,
      contactEmail: client.contactEmail,
      isArchived: client.isArchived,
      createdAt: daysAgo(client.createdDaysAgo),
      updatedAt: daysAgo(client.createdDaysAgo),
    })),
  });
};

const seedProjects = async (tx: Prisma.TransactionClient): Promise<void> => {
  await tx.project.createMany({
    data: PROJECTS.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      status: project.status,
      clientId: CLIENTS[project.clientKey].id,
      managerId: USERS[project.managerKey].id,
      startDate: dueIn(project.startInDays),
      dueDate: dueIn(project.dueInDays),
      createdAt: daysAgo(project.createdDaysAgo),
      updatedAt: daysAgo(project.createdDaysAgo),
    })),
  });

  await tx.projectMember.createMany({
    data: PROJECTS.flatMap((project) =>
      project.members.map((member) => ({
        projectId: project.id,
        userId: USERS[member].id,
        addedAt: minutesAfter(daysAgo(project.createdDaysAgo), 45),
      })),
    ),
  });
};

/**
 * Creates the task rows and returns them resolved, in creation order.
 *
 * `number` is left to the sequence rather than set explicitly: an explicit
 * insert does not advance a Postgres sequence, so the first task created through
 * the API afterwards would collide with a seeded row on `Task.number`'s unique
 * constraint.
 */
const seedTasks = async (tx: Prisma.TransactionClient): Promise<ResolvedTask[]> => {
  const resolved: ResolvedTask[] = [];
  let index = 0;

  for (const project of PROJECTS) {
    const manager = USERS[project.managerKey];

    for (const seed of project.tasks) {
      index += 1;
      const createdAt = hoursAgo(seed.createdHoursAgo);
      const status = finalStatus(seed);
      const assignee = seed.assignee ? USERS[seed.assignee] : null;
      const doneMove = seed.moves?.find((move) => move.to === TaskStatus.DONE);

      const created = await tx.task.create({
        data: {
          id: taskId(index),
          title: seed.title,
          description: seed.description,
          status,
          priority: seed.priority,
          dueDate: seed.dueInDays === null ? null : dueIn(seed.dueInDays),
          // Left false on purpose — see the header. The scheduled sweep owns
          // this column, and the fixture must not pretend to have run it.
          isOverdue: false,
          overdueFlaggedAt: null,
          completedAt: doneMove ? hoursAgo(doneMove.hoursAgo) : null,
          projectId: project.id,
          assigneeId: assignee?.id ?? null,
          createdById: manager.id,
          createdAt,
          updatedAt: lastTouched(seed, createdAt),
        },
        select: { id: true, number: true },
      });

      resolved.push({
        id: created.id,
        number: created.number,
        seed,
        project,
        managerId: manager.id,
        managerName: manager.name,
        assigneeId: assignee?.id ?? null,
        assigneeName: assignee?.name ?? null,
        createdAt,
        updatedAt: lastTouched(seed, createdAt),
        dueDate: seed.dueInDays === null ? null : dueIn(seed.dueInDays),
        status,
        completedAt: doneMove ? hoursAgo(doneMove.hoursAgo) : null,
      });
    }
  }

  return resolved;
};

/* ------------------------------------------------------------------ *
 * History synthesis
 * ------------------------------------------------------------------ */

/** Builds the project-level events: creation and team composition. */
const projectEvents = (): PendingEvent[] => {
  const events: PendingEvent[] = [];

  for (const project of PROJECTS) {
    const manager = USERS[project.managerKey];
    const createdAt = daysAgo(project.createdDaysAgo);

    events.push({
      at: createdAt,
      type: 'PROJECT_CREATED',
      projectId: project.id,
      projectName: project.name,
      taskId: null,
      taskNumber: null,
      taskTitle: null,
      actorId: manager.id,
      actorName: manager.name,
      fromStatus: null,
      toStatus: null,
      metadata: { clientName: CLIENTS[project.clientKey].name, status: project.status },
    });

    project.members.forEach((memberKey, position) => {
      const member = USERS[memberKey];
      events.push({
        at: minutesAfter(createdAt, 45 + position * 5),
        type: 'PROJECT_MEMBER_ADDED',
        projectId: project.id,
        projectName: project.name,
        taskId: null,
        taskNumber: null,
        taskTitle: null,
        actorId: manager.id,
        actorName: manager.name,
        fromStatus: null,
        toStatus: null,
        metadata: { memberId: member.id, memberName: member.name, memberRole: member.role },
      });
    });
  }

  return events;
};

/**
 * Builds every task event by replaying each task's fixture history.
 *
 * This is the function that makes the seeded feed defensible: the events are not
 * written alongside the task rows, they are *generated from the same
 * declaration*, so there is no way for the two to drift.
 */
const taskEvents = (tasks: readonly ResolvedTask[]): PendingEvent[] => {
  const events: PendingEvent[] = [];

  for (const task of tasks) {
    const base = {
      projectId: task.project.id,
      projectName: task.project.name,
      taskId: task.id,
      taskNumber: task.number,
      taskTitle: task.seed.title,
    };

    events.push({
      ...base,
      at: task.createdAt,
      type: 'TASK_CREATED',
      actorId: task.managerId,
      actorName: task.managerName,
      fromStatus: null,
      toStatus: TaskStatus.TODO,
      metadata: { priority: task.seed.priority, dueDate: task.dueDate?.toISOString() ?? null },
    });

    if (task.assigneeId) {
      events.push({
        ...base,
        at: minutesAfter(task.createdAt, 2),
        type: 'TASK_ASSIGNED',
        actorId: task.managerId,
        actorName: task.managerName,
        fromStatus: null,
        toStatus: null,
        metadata: { assigneeId: task.assigneeId, assigneeName: task.assigneeName },
      });
    }

    if (task.seed.priorityRaisedFrom) {
      events.push({
        ...base,
        at: hoursAgo(task.seed.priorityRaisedFrom.hoursAgo),
        type: 'TASK_PRIORITY_CHANGED',
        actorId: task.managerId,
        actorName: task.managerName,
        fromStatus: null,
        toStatus: null,
        metadata: { from: task.seed.priorityRaisedFrom.from, to: task.seed.priority },
      });
    }

    if (task.seed.dueDateMovedFrom) {
      events.push({
        ...base,
        at: hoursAgo(task.seed.dueDateMovedFrom.hoursAgo),
        type: 'TASK_DUE_DATE_CHANGED',
        actorId: task.managerId,
        actorName: task.managerName,
        fromStatus: null,
        toStatus: null,
        metadata: {
          from: dueIn(task.seed.dueDateMovedFrom.fromDays).toISOString(),
          to: task.dueDate?.toISOString() ?? null,
        },
      });
    }

    let from: TaskStatus = TaskStatus.TODO;
    for (const move of task.seed.moves ?? []) {
      const actor = moveActor(task, move.to);
      events.push({
        ...base,
        at: hoursAgo(move.hoursAgo),
        type: 'TASK_STATUS_CHANGED',
        actorId: actor.id,
        actorName: actor.name,
        fromStatus: from,
        toStatus: move.to,
        metadata: null,
      });
      from = move.to;
    }
  }

  return events;
};

/**
 * Writes the events oldest-first.
 *
 * Inserted one at a time rather than through `createMany`, because `seq` is the
 * cursor the feed pages on and the catch-up query compares against: it has to
 * agree with `createdAt`. A single multi-row INSERT would almost certainly
 * consume the sequence in row order — but "almost certainly" is not a property
 * worth relying on for a script that runs in under two seconds.
 */
const seedActivity = async (tx: Prisma.TransactionClient, events: readonly PendingEvent[]): Promise<number> => {
  const ordered = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());

  for (const event of ordered) {
    await tx.activityEvent.create({
      data: {
        type: event.type,
        projectId: event.projectId,
        projectName: event.projectName,
        taskId: event.taskId,
        taskNumber: event.taskNumber,
        taskTitle: event.taskTitle,
        actorId: event.actorId,
        actorName: event.actorName,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        metadata: event.metadata ?? undefined,
        createdAt: event.at,
      },
      select: { id: true },
    });
  }

  return ordered.length;
};

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

/**
 * The two notifications the brief names, backdated.
 *
 *   - the assignee is told when a task is assigned to them;
 *   - the owning manager is told when one of their tasks reaches In Review.
 *
 * A third (task completed) is included because a developer whose work is signed
 * off should hear about it, and it gives the dropdown a third type to render.
 *
 * Overdue notifications are *not* seeded: the sweep produces them on API boot.
 * Writing them here would hide whether that job actually works.
 *
 * Written directly rather than through `createNotification()` because the
 * fixture needs backdated `createdAt` values and a realistic read/unread mix,
 * neither of which the runtime helper exposes — correctly, since nothing in a
 * request handler should be able to forge either.
 */
const notificationsFor = (tasks: readonly ResolvedTask[]): PendingNotification[] => {
  const pending: PendingNotification[] = [];

  for (const task of tasks) {
    const shared = { taskId: task.id, projectId: task.project.id };

    if (task.assigneeId) {
      pending.push({
        ...shared,
        at: minutesAfter(task.createdAt, 2),
        recipientId: task.assigneeId,
        actorId: task.managerId,
        type: 'TASK_ASSIGNED',
        title: `New task assigned: #${task.number}`,
        body: `${task.managerName} assigned you "${task.seed.title}" on ${task.project.name}.`,
      });
    }

    const review = task.seed.moves?.find((move) => move.to === TaskStatus.IN_REVIEW);
    if (review && task.status === TaskStatus.IN_REVIEW && task.assigneeId) {
      pending.push({
        ...shared,
        at: hoursAgo(review.hoursAgo),
        recipientId: task.managerId,
        actorId: task.assigneeId,
        type: 'TASK_IN_REVIEW',
        title: `Task #${task.number} is ready for review`,
        body: `${task.assigneeName} moved "${task.seed.title}" to In Review on ${task.project.name}.`,
      });
    }

    const done = task.seed.moves?.find((move) => move.to === TaskStatus.DONE);
    if (done && task.assigneeId) {
      pending.push({
        ...shared,
        at: hoursAgo(done.hoursAgo),
        recipientId: task.assigneeId,
        actorId: task.managerId,
        type: 'TASK_COMPLETED',
        title: `Task #${task.number} signed off`,
        body: `${task.managerName} marked "${task.seed.title}" as Done.`,
      });
    }
  }

  return pending;
};

const seedNotifications = async (
  tx: Prisma.TransactionClient,
  pending: readonly PendingNotification[],
): Promise<number> => {
  await tx.notification.createMany({
    data: pending.map((item) => ({
      recipientId: item.recipientId,
      actorId: item.actorId,
      type: item.type,
      title: item.title,
      body: item.body,
      taskId: item.taskId,
      projectId: item.projectId,
      readAt: readAtFor(item.at),
      createdAt: item.at,
    })),
  });

  return pending.length;
};

/**
 * Seeds each user's feed high-water mark.
 *
 * Set to the newest event older than `UNSEEN_WINDOW_HOURS`, so every account has
 * a real backlog to catch up on when it first connects — which is the point of
 * `ActivityCursor` and the only way to see the "you missed N events" path
 * without waiting for someone else to do something.
 */
const seedCursors = async (tx: Prisma.TransactionClient): Promise<number> => {
  const watermark = await tx.activityEvent.aggregate({
    _max: { seq: true },
    where: { createdAt: { lt: hoursAgo(UNSEEN_WINDOW_HOURS) } },
  });
  const lastSeenSeq = watermark._max.seq ?? 0;

  await tx.activityCursor.createMany({
    data: Object.values(USERS).map((user) => ({ userId: user.id, lastSeenSeq })),
  });

  return lastSeenSeq;
};

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

const pad = (value: string, width: number): string => value.padEnd(width);

/**
 * Prints what each account will actually see.
 *
 * The counts are produced by running `activityScope()` — the same function every
 * API read goes through — so this is a check of the role rules, not a
 * description of them. If the developer rows ever showed the same event count as
 * the admin row, the scoping would be broken and the seed would say so.
 */
const printSummary = async (counts: { events: number; notifications: number }): Promise<void> => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });

  const cursors = new Map(
    (await prisma.activityCursor.findMany({ select: { userId: true, lastSeenSeq: true } })).map((row) => [
      row.userId,
      row.lastSeenSeq,
    ]),
  );

  const [clients, projects, tasks, overdue] = await Promise.all([
    prisma.client.count(),
    prisma.project.count(),
    prisma.task.count(),
    prisma.task.findMany({
      where: { status: { not: TaskStatus.DONE }, dueDate: { lt: NOW } },
      select: { number: true, title: true, dueDate: true },
      orderBy: { dueDate: 'asc' },
    }),
  ]);

  console.log(`\n  Seeded ${clients} clients · ${projects} projects · ${tasks} tasks · ${counts.events} activity events · ${counts.notifications} notifications\n`);
  console.log(`  Accounts — every one of them signs in with: ${env.SEED_PASSWORD}\n`);
  console.log(`    ${pad('ROLE', 17)}${pad('EMAIL', 22)}${pad('NAME', 16)}${pad('FEED', 7)}${pad('UNSEEN', 8)}UNREAD`);

  for (const user of users) {
    const principal: Principal = user;
    const scope = activityScope(principal);
    const lastSeenSeq = cursors.get(user.id) ?? 0;

    const [visible, unseen, unread, assigned] = await Promise.all([
      prisma.activityEvent.count({ where: scope }),
      prisma.activityEvent.count({ where: { AND: [scope, { seq: { gt: lastSeenSeq } }] } }),
      prisma.notification.count({ where: { recipientId: user.id, readAt: null } }),
      prisma.task.count({ where: { assigneeId: user.id } }),
    ]);

    const trailing = user.role === Role.DEVELOPER ? `   (${assigned} tasks assigned)` : '';
    console.log(
      `    ${pad(user.role, 17)}${pad(user.email, 22)}${pad(user.name, 16)}${pad(String(visible), 7)}${pad(String(unseen), 8)}${pad(String(unread), 6)}${trailing}`,
    );
  }

  console.log(`
  The FEED column is counted through activityScope() from src/access/rbac.ts —
  the same filter every API read and every socket broadcast uses. An admin sees
  the agency; a manager sees their own projects; a developer sees only events on
  tasks assigned to them right now. UNSEEN is what each account's catch-up query
  will return on first connect.

  Northwind Retail is the client of two projects owned by two different managers,
  so GET /api/clients must report projectCount 1 for Arjun, 1 for Neha and 2 for
  Priya. That is the cheapest way to check the client-list scoping by hand.`);

  if (overdue.length > 0) {
    console.log(`\n  ${overdue.length} tasks are already past their due date and are intentionally NOT flagged:\n`);
    for (const task of overdue) {
      const days = Math.round((NOW.getTime() - (task.dueDate?.getTime() ?? 0)) / DAY);
      console.log(`    #${pad(String(task.number), 4)}${pad(task.title, 52)} ${days}d late`);
    }
    console.log(`
  isOverdue is owned by the scheduled sweep in src/jobs/overdue.job.ts, which
  runs once on API boot and then on every OVERDUE_CRON tick. Start the server and
  the flags, the activity events and the assignee notifications appear — which is
  the difference between a scheduled job and a column set by a seed script.`);
  }

  console.log('');
};

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Guard for `SEED_ON_BOOT` in docker-compose, which runs with
 * `NODE_ENV=production`.
 *
 * First boot of an empty database should be populated; a later restart or a
 * redeploy must not wipe whatever has been done since. In development the seed
 * always rebuilds, because that is the whole point of running it.
 */
const shouldSkip = async (): Promise<boolean> => {
  if (env.SEED_FORCE || env.NODE_ENV !== 'production') return false;
  return (await prisma.user.count()) > 0;
};

const main = async (): Promise<void> => {
  if (await shouldSkip()) {
    console.log('\n  Database already contains users and NODE_ENV=production — skipping seed.');
    console.log('  Set SEED_FORCE=true to rebuild the fixture anyway (this deletes existing data).\n');
    return;
  }

  const startedAt = Date.now();

  // One transaction for the whole fixture: a half-seeded database — projects
  // without their history, notifications pointing at tasks that failed to
  // insert — is worse than no fixture at all, because it looks like it worked.
  const counts = await prisma.$transaction(
    async (tx) => {
      await resetDomainData(tx);
      await seedUsers(tx);
      await seedClients(tx);
      await seedProjects(tx);

      const tasks = await seedTasks(tx);
      const events = await seedActivity(tx, [...projectEvents(), ...taskEvents(tasks)]);
      const notifications = await seedNotifications(tx, notificationsFor(tasks));
      await seedCursors(tx);

      return { events, notifications };
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  await printSummary(counts);
  console.log(`  Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
};

main()
  .catch((error: unknown) => {
    console.error('\n  Seed failed:\n');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
