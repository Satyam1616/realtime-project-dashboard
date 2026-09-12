/**
 * Activity.
 *
 * The same feed the dashboard shows in a sidebar, given the whole page and the
 * ability to page backwards through history. What each role sees is decided by
 * `activityScope()` in SQL — this page adds no filtering of its own beyond the
 * optional project narrowing, which is itself a server-side `projectId`
 * parameter rather than a client-side array filter.
 */
import { useSearchParams } from 'react-router-dom';
import { toQuery } from '../lib/api';
import { useApiQuery } from '../hooks/useApiQuery';
import { useCurrentUser } from '../providers/AuthProvider';
import type { Paged, ProjectDto } from '../types/api';
import { ActivityFeed } from '../components/ActivityFeed';

export const ActivityPage = (): React.JSX.Element => {
  const user = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('projectId') ?? '';

  // Only for the picker. An out-of-scope id typed into the URL is rejected by
  // the API, not quietly ignored here.
  const { data } = useApiQuery<Paged<ProjectDto>>(`/projects${toQuery({ limit: 100, sort: 'name', order: 'asc' })}`);
  const projects = data?.items ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Activity</h1>
          <p className="page-subtitle">
            {user.role === 'ADMIN'
              ? 'Every project, every task, everyone — the global feed.'
              : user.role === 'PROJECT_MANAGER'
                ? "Everything happening on the projects you manage."
                : 'Changes to the tasks assigned to you.'}
          </p>
        </div>

        {projects.length > 1 ? (
          <div className="filter-group">
            <label className="label" htmlFor="activity-project">
              Project
            </label>
            <select
              id="activity-project"
              className="select"
              value={projectId}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                if (event.target.value) next.set('projectId', event.target.value);
                else next.delete('projectId');
                setParams(next, { replace: true });
              }}
            >
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </header>

      {/*
        Keyed on the project so switching narrows the feed by remounting: the
        catch-up banner, the live buffer and the history cursor all belong to
        one scope, and carrying them across would mix two.
      */}
      <ActivityFeed
        key={projectId || 'all'}
        {...(projectId ? { projectId } : {})}
        title={projectId ? 'Project activity' : 'All activity'}
        limit={40}
        paginate
        catchUp={!projectId}
        maxHeight={700}
      />
    </div>
  );
};
