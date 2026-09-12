/**
 * Tasks.
 *
 * The URL is the state. `useSearchParams` feeds both the filter bar and the
 * request path, so the page has no filter state of its own to fall out of sync
 * — pressing back really does restore the previous view, and the address bar is
 * a shareable link to it.
 *
 * What each role sees is *not* decided here. `GET /tasks` applies `taskScope()`
 * in SQL: a developer gets their own assignments whatever query parameters they
 * send, including another developer's `assigneeId`. This page renders whatever
 * came back.
 */
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toQuery } from '../lib/api';
import { canCreateProject } from '../lib/permissions';
import { plural } from '../lib/labels';
import { useApiQuery } from '../hooks/useApiQuery';
import { useAssignableUsers } from '../hooks/usePickers';
import { useLiveTaskPatch, useRefetchOnActivity } from '../hooks/useLiveTasks';
import { useCurrentUser } from '../providers/AuthProvider';
import type { Paged, ProjectDto, TaskDto } from '../types/api';
import { TaskFilters, readTaskFilters, taskFiltersToQuery } from '../components/TaskFilters';
import { TaskTable } from '../components/TaskTable';
import type { TaskSortKey } from '../components/TaskTable';
import { TaskDialog } from '../components/TaskDialog';
import { EmptyState, ErrorState, InlineError, LoadingRows } from '../components/ui/Feedback';

const PAGE_SIZE = 50;

export const TasksPage = (): React.JSX.Element => {
  const user = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const filters = readTaskFilters(params);
  const offset = Number(params.get('offset') ?? 0);

  const path = `/tasks${toQuery({ ...taskFiltersToQuery(filters), limit: PAGE_SIZE, offset })}`;
  const { data, error, loading, refetch, setData } = useApiQuery<Paged<TaskDto>>(path);

  // Projects are needed for the create dialog's picker and for the project
  // filter; a developer cannot create tasks, so they never pay for the request.
  const canCreate = canCreateProject(user);
  const { data: projectData } = useApiQuery<Paged<ProjectDto>>('/projects?limit=100', canCreate);
  const { users: assignees } = useAssignableUsers(user.role !== 'DEVELOPER');

  useRefetchOnActivity(refetch);

  const setTasks = useCallback(
    (updater: (current: TaskDto[]) => TaskDto[]) =>
      setData((current) => (current ? { ...current, items: updater(current.items) } : current)),
    [setData],
  );
  const highlighted = useLiveTaskPatch(setTasks);

  const sort = useMemo(
    () => ({ key: filters.sort as TaskSortKey, order: filters.order }),
    [filters.sort, filters.order],
  );

  /**
   * Clicking a column header re-sorts through the URL, so the API does the
   * sorting over the whole result set rather than the browser reordering one
   * page of it.
   */
  const onSort = (key: TaskSortKey): void => {
    const next = new URLSearchParams(params);
    const sameKey = filters.sort === key;
    next.set('sort', key);
    next.set('order', sameKey && filters.order === 'desc' ? 'asc' : 'desc');
    next.delete('offset');
    setParams(next, { replace: true });
  };

  const goToOffset = (value: number): void => {
    const next = new URLSearchParams(params);
    if (value <= 0) next.delete('offset');
    else next.set('offset', String(value));
    setParams(next);
  };

  const total = data?.total ?? 0;
  const shown = data?.items.length ?? 0;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Tasks</h1>
          <p className="page-subtitle">
            {user.role === 'DEVELOPER'
              ? 'Everything assigned to you, newest first.'
              : 'Every task within your projects. Filters are part of the URL — copy the address to share this view.'}
          </p>
        </div>
        {canCreate ? (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New task
          </button>
        ) : null}
      </header>

      <TaskFilters
        {...(user.role === 'DEVELOPER' ? { hide: ['assignee' as const] } : {})}
        {...(assignees.length > 0 ? { assignees } : {})}
      />

      {actionError ? <InlineError message={actionError} /> : null}

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && !data ? (
        <LoadingRows rows={8} />
      ) : shown === 0 ? (
        <EmptyState
          title="No tasks match this view"
          hint={
            total === 0 && params.size === 0
              ? 'Nothing has been assigned to you yet.'
              : 'Try clearing a filter — the current one is in the address bar.'
          }
        />
      ) : (
        <>
          <TaskTable
            tasks={data?.items ?? []}
            highlighted={highlighted}
            sort={sort}
            onSort={onSort}
            onError={setActionError}
            {...(user.role === 'DEVELOPER' ? { hideAssignee: true } : {})}
          />

          <div className="row-between">
            <span className="small muted">
              {offset + 1}–{offset + shown} of {plural(total, 'task')}
            </span>
            <div className="row gap-2">
              <button
                type="button"
                className="btn btn-sm"
                disabled={offset === 0}
                onClick={() => goToOffset(offset - PAGE_SIZE)}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={offset + shown >= total}
                onClick={() => goToOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {creating ? (
        <TaskDialog
          projects={projectData?.items ?? []}
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
