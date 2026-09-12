/**
 * Dashboard.
 *
 * Switches on `payload.variant`, not on `user.role`. The server chooses the
 * variant from the authenticated principal, so there is no request parameter to
 * tamper with — and rendering from the discriminant means the layout and the
 * data can never disagree about which role is being served.
 */
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  AdminDashboard,
  DeveloperDashboard,
  ManagerDashboard,
  PresenceDto,
  TaskDto,
} from '../types/api';
import { TASK_PRIORITIES, TASK_STATUSES } from '../types/api';
import {
  PRIORITY_LABEL,
  PRIORITY_SLUG,
  ROLE_SHORT,
  STATUS_LABEL,
  STATUS_SLUG,
  plural,
} from '../lib/labels';
import { dueLabel, shortDate } from '../lib/time';
import { useApiQuery } from '../hooks/useApiQuery';
import { useRefetchOnActivity } from '../hooks/useLiveTasks';
import { useRealtimeEvent } from '../providers/SocketProvider';
import { useCurrentUser } from '../providers/AuthProvider';
import { ActivityFeed } from '../components/ActivityFeed';
import { DistributionBars, StatTile } from '../components/Stats';
import { TaskTable } from '../components/TaskTable';
import { Avatar } from '../components/ui/Avatar';
import { ProjectStatusBadge } from '../components/ui/Badges';
import { EmptyState, ErrorState, LoadingRows } from '../components/ui/Feedback';

type DashboardPayload = AdminDashboard | ManagerDashboard | DeveloperDashboard;

/** The bar colours come from the same tokens as the badges, via the slug maps. */
const statusBars = (counts: Record<string, number>): Array<{ label: string; value: number; color: string }> =>
  TASK_STATUSES.map((status) => ({
    label: STATUS_LABEL[status],
    value: counts[status] ?? 0,
    color: `var(--status-${STATUS_SLUG[status]})`,
  }));

const priorityBars = (counts: Record<string, number>): Array<{ label: string; value: number; color: string }> =>
  TASK_PRIORITIES.map((priority) => ({
    label: PRIORITY_LABEL[priority],
    value: counts[priority] ?? 0,
    color: `var(--priority-${PRIORITY_SLUG[priority]})`,
  }));

/* ------------------------------------------------------------------ *
 * Presence — the only tile fed by the socket rather than by HTTP
 * ------------------------------------------------------------------ */

/**
 * The HTTP payload seeds this once; every change after that arrives as
 * `presence:update`. Polling it would be both slower and, per the brief,
 * the wrong mechanism — the count is derived from live socket connections, so
 * the socket is the natural transport for it.
 */
const PresenceCard = ({ initial }: { initial: PresenceDto }): React.JSX.Element => {
  const [presence, setPresence] = useState(initial);

  useRealtimeEvent(
    'presence:update',
    useCallback((next: PresenceDto) => setPresence(next), []),
  );

  return (
    <section className="card">
      <header className="card-header">
        <h2 className="card-title">Online now</h2>
        <span className="badge badge-accent">{presence.onlineCount}</span>
      </header>

      {presence.users.length === 0 ? (
        <p className="small dim">Nobody else is connected.</p>
      ) : (
        <ul className="presence-list">
          {presence.users.map((person) => (
            <li className="presence-row" key={person.id}>
              <Avatar name={person.name} color={person.avatarColor} size="sm" />
              <span className="truncate">{person.name}</span>
              <span className="tiny dim">{ROLE_SHORT[person.role]}</span>
              <span className="online-dot" aria-label="Online" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/* ------------------------------------------------------------------ *
 * Per-role bodies
 * ------------------------------------------------------------------ */

const AdminView = ({ data }: { data: AdminDashboard }): React.JSX.Element => (
  <>
    <div className="stat-grid">
      <StatTile label="Projects" value={data.totals.projects} hint={`${data.totals.activeProjects} active`} />
      <StatTile label="Tasks" value={data.totals.tasks} />
      <StatTile
        label="Overdue"
        value={data.totals.overdueTasks}
        tone={data.totals.overdueTasks > 0 ? 'danger' : 'ok'}
        hint="Flagged by the scheduler"
      />
      <StatTile label="Clients" value={data.totals.clients} />
      <StatTile label="People" value={data.totals.users} />
      <StatTile label="Online" value={data.presence.onlineCount} tone="accent" hint="Live socket presence" />
    </div>

    <div className="split">
      <div className="col gap-5">
        <section className="card">
          <header className="card-header">
            <h2 className="card-title">Tasks by status</h2>
          </header>
          <DistributionBars data={statusBars(data.tasksByStatus)} />
        </section>

        <section className="card">
          <header className="card-header">
            <h2 className="card-title">Tasks by priority</h2>
          </header>
          <DistributionBars data={priorityBars(data.tasksByPriority)} />
        </section>

        <section className="card card-flush">
          <header className="card-header">
            <h2 className="card-title">Overdue tasks</h2>
            <Link className="small" to="/tasks?overdue=true">
              View all
            </Link>
          </header>
          {data.overdueTasks.length === 0 ? (
            <EmptyState title="Nothing overdue" hint="Every task is inside its due date." />
          ) : (
            <TaskTable tasks={data.overdueTasks} />
          )}
        </section>
      </div>

      <div className="col gap-5">
        <PresenceCard initial={data.presence} />
        <ActivityFeed title="Global activity" limit={25} maxHeight={480} />
      </div>
    </div>
  </>
);

const ManagerView = ({ data }: { data: ManagerDashboard }): React.JSX.Element => (
  <>
    <div className="stat-grid">
      <StatTile label="My projects" value={data.totals.projects} hint={`${data.totals.activeProjects} active`} />
      <StatTile label="Tasks" value={data.totals.tasks} />
      <StatTile
        label="Awaiting review"
        value={data.totals.awaitingReview}
        {...(data.totals.awaitingReview > 0 ? { tone: 'warn' as const } : {})}
        hint="Waiting on you to sign off"
      />
      <StatTile
        label="Overdue"
        value={data.totals.overdueTasks}
        tone={data.totals.overdueTasks > 0 ? 'danger' : 'ok'}
      />
    </div>

    <div className="split">
      <div className="col gap-5">
        <section className="card card-flush">
          <header className="card-header">
            <h2 className="card-title">My projects</h2>
            <Link className="small" to="/projects">
              All projects
            </Link>
          </header>

          {data.projects.length === 0 ? (
            <EmptyState title="No projects yet" hint="Create one to start assigning work." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Client</th>
                    <th>Status</th>
                    <th>Open</th>
                    <th>Overdue</th>
                    <th>Due</th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((project) => (
                    <tr key={project.id}>
                      <td>
                        <Link to={`/projects/${project.id}`} className="strong">
                          {project.name}
                        </Link>
                      </td>
                      <td className="muted truncate">{project.clientName}</td>
                      <td>
                        <ProjectStatusBadge status={project.status} />
                      </td>
                      <td className="mono">{project.openTasks}</td>
                      <td className={project.overdueTasks > 0 ? 'mono danger-text' : 'mono dim'}>
                        {project.overdueTasks}
                      </td>
                      <td className="small muted nowrap">{shortDate(project.dueDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card card-flush">
          <header className="card-header">
            <h2 className="card-title">Due this week</h2>
            <span className="small dim">{plural(data.dueThisWeek.length, 'task')}</span>
          </header>
          {data.dueThisWeek.length === 0 ? (
            <EmptyState title="Nothing due this week" />
          ) : (
            <TaskTable tasks={data.dueThisWeek} />
          )}
        </section>

        <section className="card">
          <header className="card-header">
            <h2 className="card-title">Tasks by priority</h2>
          </header>
          <DistributionBars data={priorityBars(data.tasksByPriority)} />
        </section>
      </div>

      <ActivityFeed title="My team's activity" limit={25} maxHeight={620} />
    </div>
  </>
);

const DeveloperView = ({ data }: { data: DeveloperDashboard }): React.JSX.Element => {
  const next: TaskDto | undefined = data.tasks[0];

  return (
    <>
      <div className="stat-grid">
        <StatTile label="Assigned to me" value={data.totals.assigned} />
        <StatTile label="Still open" value={data.totals.openTasks} />
        <StatTile
          label="Overdue"
          value={data.totals.overdueTasks}
          tone={data.totals.overdueTasks > 0 ? 'danger' : 'ok'}
        />
        <StatTile label="Due this week" value={data.totals.dueThisWeek} tone="warn" />
        <StatTile label="Done this week" value={data.totals.completedThisWeek} tone="ok" />
      </div>

      <div className="split">
        <div className="col gap-5">
          {next ? (
            <section className="card">
              <header className="card-header">
                <h2 className="card-title">Up next</h2>
                <span className="small dim">Highest priority, nearest deadline</span>
              </header>
              <Link to={`/tasks/${next.id}`} className="strong">
                #{next.number} · {next.title}
              </Link>
              <p className="small muted">
                {next.project.name} · {dueLabel(next.dueDate)}
              </p>
            </section>
          ) : null}

          <section className="card card-flush">
            <header className="card-header">
              <h2 className="card-title">My tasks</h2>
              <Link className="small" to="/tasks">
                Filter and search
              </Link>
            </header>
            {data.tasks.length === 0 ? (
              <EmptyState title="No tasks assigned" hint="Your project manager will assign work here." />
            ) : (
              <TaskTable tasks={data.tasks} hideAssignee />
            )}
          </section>
        </div>

        <ActivityFeed title="Activity on my tasks" limit={25} maxHeight={620} />
      </div>
    </>
  );
};

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export const DashboardPage = (): React.JSX.Element => {
  const user = useCurrentUser();
  const { data, error, loading, refetch } = useApiQuery<DashboardPayload>('/dashboard');

  // The tiles are aggregates — an overdue count cannot be recomputed from a
  // single task event without re-deriving the scheduler's logic here — so a
  // relevant event triggers a (debounced) re-read rather than a local patch.
  useRefetchOnActivity(refetch);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>
            {new Date().getHours() < 12
              ? 'Good morning'
              : new Date().getHours() < 18
                ? 'Good afternoon'
                : 'Good evening'}
            , {user.name.split(' ')[0]}
          </h1>
          <p className="page-subtitle">
            {user.role === 'ADMIN'
              ? 'Everything across the agency.'
              : user.role === 'PROJECT_MANAGER'
                ? 'Your projects and the people working on them.'
                : 'Your work, sorted by priority then deadline.'}
          </p>
        </div>
      </header>

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingRows rows={6} height={72} />
      ) : !data ? null : data.variant === 'admin' ? (
        <AdminView data={data} />
      ) : data.variant === 'manager' ? (
        <ManagerView data={data} />
      ) : (
        <DeveloperView data={data} />
      )}
    </div>
  );
};
