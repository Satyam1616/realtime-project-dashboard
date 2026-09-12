/**
 * Projects.
 *
 * `GET /projects` applies `projectScope()`: an admin sees everything, a manager
 * sees the projects they own, a developer sees the projects containing tasks
 * assigned to them. This page never filters by role — the list that arrives is
 * already the list this account is allowed to see.
 *
 * The per-project task counts are also role-scoped server-side, so a
 * developer's "4 open" badge agrees with the task list they can actually open
 * rather than advertising work they cannot read.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toQuery } from '../lib/api';
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL, plural } from '../lib/labels';
import { dueLabel } from '../lib/time';
import { canCreateProject, canViewClients } from '../lib/permissions';
import { useApiQuery } from '../hooks/useApiQuery';
import { useAssignableUsers, useClients } from '../hooks/usePickers';
import { useRefetchOnActivity } from '../hooks/useLiveTasks';
import { useCurrentUser } from '../providers/AuthProvider';
import type { Paged, ProjectDto, ProjectStatus } from '../types/api';
import { ProjectDialog } from '../components/ProjectDialog';
import { UserChip } from '../components/ui/Avatar';
import { ProjectStatusBadge } from '../components/ui/Badges';
import { EmptyState, ErrorState, LoadingRows } from '../components/ui/Feedback';

const ProjectCard = ({ project }: { project: ProjectDto }): React.JSX.Element => {
  const { taskCounts } = project;
  const done = taskCounts.total > 0 ? Math.round((taskCounts.done / taskCounts.total) * 100) : 0;

  return (
    <Link to={`/projects/${project.id}`} className="card project-card">
      <header className="row-between">
        <span className="strong truncate">{project.name}</span>
        <ProjectStatusBadge status={project.status} />
      </header>

      <p className="small muted truncate">
        {project.client.name}
        {project.client.company ? ` · ${project.client.company}` : ''}
      </p>

      <div className="progress" role="img" aria-label={`${done}% complete`}>
        <span className="progress-fill" style={{ width: `${done}%` }} />
      </div>

      <div className="row-between small">
        <span className="muted">
          {taskCounts.total === 0 ? 'No tasks' : `${done}% done · ${plural(taskCounts.total, 'task')}`}
        </span>
        {taskCounts.overdue > 0 ? (
          <span className="danger-text strong">{taskCounts.overdue} overdue</span>
        ) : null}
      </div>

      <footer className="row-between">
        <UserChip name={project.manager.name} color={project.manager.avatarColor} />
        <span className="tiny dim nowrap">{dueLabel(project.dueDate)}</span>
      </footer>
    </Link>
  );
};

export const ProjectsPage = (): React.JSX.Element => {
  const user = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);

  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  // Forwarded, not merely tolerated: a link such as `/projects?clientId=…`
  // arrives from the project detail page and from the clients table, and the
  // parameter names are the ones the API already accepts.
  const clientId = params.get('clientId') ?? '';
  const managerId = params.get('managerId') ?? '';

  const { clients } = useClients(canViewClients(user));
  // Admin-only pivot: the API ignores `managerId` for anyone else, because a
  // manager's scope already fixes it.
  const { users } = useAssignableUsers(user.role === 'ADMIN');
  const managers = users.filter((person) => person.role === 'PROJECT_MANAGER');

  const { data, error, loading, refetch } = useApiQuery<Paged<ProjectDto>>(
    `/projects${toQuery({ status, q, clientId, managerId, limit: 100, sort: 'updatedAt', order: 'desc' })}`,
  );

  useRefetchOnActivity(refetch, {
    types: new Set(['PROJECT_CREATED', 'PROJECT_UPDATED', 'TASK_CREATED', 'TASK_STATUS_CHANGED', 'TASK_OVERDUE']),
  });

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="page-subtitle">
            {user.role === 'ADMIN'
              ? 'Every project across the agency.'
              : user.role === 'PROJECT_MANAGER'
                ? 'Projects you own. Only their creator — or an admin — can change them.'
                : 'Projects containing work assigned to you.'}
          </p>
        </div>
        {canCreateProject(user) ? (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New project
          </button>
        ) : null}
      </header>

      <div className="filters">
        <div className="filter-group">
          <span className="label">Search</span>
          <input
            className="input"
            type="search"
            placeholder="Name or description…"
            defaultValue={q}
            onKeyDown={(event) => {
              if (event.key === 'Enter') update('q', event.currentTarget.value.trim());
            }}
            onBlur={(event) => update('q', event.currentTarget.value.trim())}
          />
        </div>

        <div className="filter-group">
          <span className="label">Status</span>
          <select className="select" value={status} onChange={(event) => update('status', event.target.value)}>
            <option value="">Any status</option>
            {PROJECT_STATUSES.map((value: ProjectStatus) => (
              <option key={value} value={value}>
                {PROJECT_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </div>

        {canViewClients(user) ? (
          <div className="filter-group">
            <span className="label">Client</span>
            <select
              className="select"
              value={clientId}
              onChange={(event) => update('clientId', event.target.value)}
            >
              <option value="">Any client</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </div>
        ) : clientId ? (
          /* A developer cannot read the client list, so a client filter that
             arrived in the URL is shown as something to clear rather than a
             picker that would be empty. */
          <button type="button" className="chip" aria-pressed="true" onClick={() => update('clientId', '')}>
            One client · clear
          </button>
        ) : null}

        {user.role === 'ADMIN' && managers.length > 0 ? (
          <div className="filter-group">
            <span className="label">Manager</span>
            <select
              className="select"
              value={managerId}
              onChange={(event) => update('managerId', event.target.value)}
            >
              <option value="">Any manager</option>
              {managers.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingRows rows={6} height={140} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="No projects to show"
          hint={
            status || q || clientId || managerId
              ? 'Nothing matches the current filter.'
              : user.role === 'DEVELOPER'
                ? 'A project appears here once a task in it is assigned to you.'
                : 'Create a project to get started.'
          }
          {...(canCreateProject(user)
            ? {
                action: (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
                    New project
                  </button>
                ),
              }
            : {})}
        />
      ) : (
        <div className="project-grid">
          {data?.items.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}

      {creating ? (
        <ProjectDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            refetch();
          }}
        />
      ) : null}
    </div>
  );
};
