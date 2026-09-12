/**
 * Task filter bar.
 *
 * The single source of truth for the filter state is the **URL**, not component
 * state. `useSearchParams` is read on render and written on change, so:
 *
 *   /tasks?status=IN_PROGRESS,IN_REVIEW&priority=HIGH,CRITICAL&dueTo=2026-09-30
 *
 * survives a refresh, works with the back button, and can be pasted into Slack
 * — which is what the brief means by "shareable as URLs". The same parameter
 * names are sent straight through to the API (`listTasksQuerySchema`), so there
 * is no translation layer to keep in step; the address bar *is* the query.
 *
 * `q`, `limit` and `offset` are part of the same contract but are owned by the
 * page (search box, pagination), so this component leaves unknown parameters
 * untouched when it writes.
 */
import { useSearchParams } from 'react-router-dom';
import { TASK_PRIORITIES, TASK_STATUSES } from '../types/api';
import type { TaskPriority, TaskStatus } from '../types/api';
import { PRIORITY_LABEL, PRIORITY_SLUG, STATUS_LABEL, STATUS_SLUG } from '../lib/labels';

export interface TaskFilterState {
  status: TaskStatus[];
  priority: TaskPriority[];
  dueFrom: string;
  dueTo: string;
  overdue: boolean;
  unassigned: boolean;
  assigneeId: string;
  projectId: string;
  q: string;
  sort: string;
  order: 'asc' | 'desc';
}

const csv = (value: string | null): string[] =>
  value ? value.split(',').map((part) => part.trim()).filter(Boolean) : [];

/** Read the filter state out of the URL. Pure — no component state involved. */
export const readTaskFilters = (params: URLSearchParams): TaskFilterState => ({
  status: csv(params.get('status')).filter((value): value is TaskStatus =>
    (TASK_STATUSES as readonly string[]).includes(value),
  ),
  priority: csv(params.get('priority')).filter((value): value is TaskPriority =>
    (TASK_PRIORITIES as readonly string[]).includes(value),
  ),
  dueFrom: params.get('dueFrom') ?? '',
  dueTo: params.get('dueTo') ?? '',
  overdue: params.get('overdue') === 'true',
  unassigned: params.get('unassigned') === 'true',
  assigneeId: params.get('assigneeId') ?? '',
  projectId: params.get('projectId') ?? '',
  q: params.get('q') ?? '',
  sort: params.get('sort') ?? 'createdAt',
  order: params.get('order') === 'asc' ? 'asc' : 'desc',
});

/**
 * Turn the filter state back into the query string the API expects.
 *
 * Deliberately omits defaults (`sort=createdAt`, `order=desc`) so an unfiltered
 * URL stays clean, and omits `limit`/`offset` because the caller adds those.
 */
export const taskFiltersToQuery = (filters: TaskFilterState): Record<string, string | string[] | undefined> => ({
  ...(filters.status.length > 0 ? { status: filters.status } : {}),
  ...(filters.priority.length > 0 ? { priority: filters.priority } : {}),
  ...(filters.dueFrom ? { dueFrom: filters.dueFrom } : {}),
  ...(filters.dueTo ? { dueTo: filters.dueTo } : {}),
  ...(filters.overdue ? { overdue: 'true' } : {}),
  ...(filters.unassigned ? { unassigned: 'true' } : {}),
  ...(filters.assigneeId ? { assigneeId: filters.assigneeId } : {}),
  ...(filters.projectId ? { projectId: filters.projectId } : {}),
  ...(filters.q ? { q: filters.q } : {}),
  sort: filters.sort,
  order: filters.order,
});

export const activeFilterCount = (filters: TaskFilterState): number =>
  (filters.status.length > 0 ? 1 : 0) +
  (filters.priority.length > 0 ? 1 : 0) +
  (filters.dueFrom ? 1 : 0) +
  (filters.dueTo ? 1 : 0) +
  (filters.overdue ? 1 : 0) +
  (filters.unassigned ? 1 : 0) +
  (filters.assigneeId ? 1 : 0) +
  (filters.q ? 1 : 0);

interface TaskFiltersProps {
  /**
   * Parameters this bar must not render or clear — a project page pins
   * `projectId` in the path, and a developer has no use for an assignee filter
   * (their scope is already themselves).
   */
  hide?: Array<'projectId' | 'assignee'>;
  /** Assignee options, when the caller has them (admins and managers). */
  assignees?: Array<{ id: string; name: string }>;
}

export const TaskFilters = ({ hide = [], assignees }: TaskFiltersProps): React.JSX.Element => {
  const [params, setParams] = useSearchParams();
  const filters = readTaskFilters(params);

  /**
   * Every write goes through here. Mutating a copy of the *current* params
   * keeps parameters this component does not own (`limit`, `offset`, anything a
   * page adds later) intact, and resetting `offset` is correct because the
   * filtered result set no longer has the same page boundaries.
   */
  const update = (changes: Record<string, string | null>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    next.delete('offset');
    setParams(next, { replace: true });
  };

  const toggleInCsv = (key: 'status' | 'priority', value: string): void => {
    const current = csv(params.get(key));
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    update({ [key]: next.length > 0 ? next.join(',') : null });
  };

  const clearAll = (): void => {
    const next = new URLSearchParams();
    // Anything pinned by the surrounding page is preserved; only filters go.
    for (const key of hide.includes('projectId') ? ['projectId'] : []) {
      const value = params.get(key);
      if (value) next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  const count = activeFilterCount(filters);

  return (
    <div className="filters" role="search">
      <div className="filter-group">
        <span className="label">Status</span>
        <div className="chip-row">
          {TASK_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`chip chip-${STATUS_SLUG[status]}`}
              aria-pressed={filters.status.includes(status)}
              onClick={() => toggleInCsv('status', status)}
            >
              {STATUS_LABEL[status]}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-group">
        <span className="label">Priority</span>
        <div className="chip-row">
          {TASK_PRIORITIES.map((priority) => (
            <button
              key={priority}
              type="button"
              className={`chip chip-${PRIORITY_SLUG[priority]}`}
              aria-pressed={filters.priority.includes(priority)}
              onClick={() => toggleInCsv('priority', priority)}
            >
              {PRIORITY_LABEL[priority]}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-group">
        <span className="label">Due from</span>
        <input
          className="input"
          type="date"
          value={filters.dueFrom}
          aria-label="Due date from"
          onChange={(event) => update({ dueFrom: event.target.value })}
        />
      </div>

      <div className="filter-group">
        <span className="label">Due to</span>
        <input
          className="input"
          type="date"
          value={filters.dueTo}
          aria-label="Due date to"
          onChange={(event) => update({ dueTo: event.target.value })}
        />
      </div>

      {hide.includes('assignee') || !assignees ? null : (
        <div className="filter-group">
          <span className="label">Assignee</span>
          <select
            className="select"
            aria-label="Assignee"
            value={filters.unassigned ? '__unassigned' : filters.assigneeId}
            onChange={(event) => {
              const value = event.target.value;
              if (value === '__unassigned') update({ unassigned: 'true', assigneeId: null });
              else update({ assigneeId: value || null, unassigned: null });
            }}
          >
            <option value="">Anyone</option>
            <option value="__unassigned">Unassigned</option>
            {assignees.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="filter-group">
        <span className="label">Sort</span>
        <select
          className="select"
          aria-label="Sort order"
          value={`${filters.sort}:${filters.order}`}
          onChange={(event) => {
            const [sort, order] = event.target.value.split(':');
            update({ sort: sort ?? 'createdAt', order: order ?? 'desc' });
          }}
        >
          <option value="priority:desc">Priority (Critical first)</option>
          <option value="dueDate:asc">Due date (soonest)</option>
          <option value="dueDate:desc">Due date (latest)</option>
          <option value="createdAt:desc">Newest</option>
          <option value="createdAt:asc">Oldest</option>
          <option value="updatedAt:desc">Recently updated</option>
          <option value="status:asc">Status</option>
          <option value="number:asc">Task number</option>
          <option value="title:asc">Title (A–Z)</option>
        </select>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={filters.overdue}
          onChange={(event) => update({ overdue: event.target.checked ? 'true' : null })}
        />
        <span>Overdue only</span>
      </label>

      {count > 0 ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={clearAll}>
          Clear {count === 1 ? 'filter' : `${count} filters`}
        </button>
      ) : null}
    </div>
  );
};
