/**
 * Task table.
 *
 * Shared by the tasks page, the dashboards and the project detail view. Sorting
 * is delegated upward — the API sorts in SQL over the whole result set, and a
 * client-side sort of the current page would silently disagree with it.
 */
import { Link, useNavigate } from 'react-router-dom';
import type { TaskDto } from '../types/api';
import { shortDate } from '../lib/time';
import { canUpdateTask } from '../lib/permissions';
import { useCurrentUser } from '../providers/AuthProvider';
import { OverdueBadge, PriorityBadge, StatusBadge } from './ui/Badges';
import { UserChip } from './ui/Avatar';
import { TaskStatusSelect } from './TaskStatusSelect';

export type TaskSortKey = 'number' | 'title' | 'status' | 'priority' | 'dueDate' | 'updatedAt';

interface TaskTableProps {
  tasks: TaskDto[];
  /** Hide the project column when the surrounding view is already scoped. */
  hideProject?: boolean;
  hideAssignee?: boolean;
  /** Ids to flash because a live event just changed them. */
  highlighted?: ReadonlySet<string>;
  sort?: { key: TaskSortKey; order: 'asc' | 'desc' };
  onSort?: (key: TaskSortKey) => void;
  onError?: (message: string) => void;
}

const SortableTh = ({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: TaskSortKey;
  /*
   * These two admit an explicit `undefined`, unlike `TaskTableProps` above.
   * Under `exactOptionalPropertyTypes` an absent property and one set to
   * `undefined` are different types, and this header is handed whatever the
   * table was given — often nothing. Relaxing the private helper keeps the
   * conditional-spread dance out of five call sites; the public props stay
   * strict, so a caller still cannot pass `sort={undefined}`.
   */
  sort?: { key: TaskSortKey; order: 'asc' | 'desc' } | undefined;
  onSort?: ((key: TaskSortKey) => void) | undefined;
}): React.JSX.Element => {
  if (!onSort) return <th>{label}</th>;
  const active = sort?.key === sortKey;

  return (
    <th
      className="th-sortable"
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (sort?.order === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      {active ? (
        <span className="sort-caret" aria-hidden="true">
          {sort?.order === 'asc' ? '↑' : '↓'}
        </span>
      ) : null}
    </th>
  );
};

export const TaskTable = ({
  tasks,
  hideProject,
  hideAssignee,
  highlighted,
  sort,
  onSort,
  onError,
}: TaskTableProps): React.JSX.Element => {
  const user = useCurrentUser();
  const navigate = useNavigate();

  return (
    <div className="table-wrap">
      <table className="table table-clickable">
        <thead>
          <tr>
            <SortableTh label="#" sortKey="number" sort={sort} onSort={onSort} />
            <SortableTh label="Task" sortKey="title" sort={sort} onSort={onSort} />
            {hideProject ? null : <th>Project</th>}
            {hideAssignee ? null : <th>Assignee</th>}
            <SortableTh label="Priority" sortKey="priority" sort={sort} onSort={onSort} />
            <SortableTh label="Due" sortKey="dueDate" sort={sort} onSort={onSort} />
            <SortableTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.id}
              onClick={() => navigate(`/tasks/${task.id}`)}
              className={highlighted?.has(task.id) ? 'just-changed' : undefined}
            >
              <td className="mono dim">{task.number}</td>

              <td style={{ maxWidth: 360 }}>
                <div className="row gap-2" style={{ minWidth: 0 }}>
                  <span className="truncate strong">{task.title}</span>
                  {task.isOverdue ? <OverdueBadge /> : null}
                </div>
              </td>

              {hideProject ? null : (
                <td>
                  <Link
                    to={`/projects/${task.project.id}`}
                    className="muted truncate"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {task.project.name}
                  </Link>
                </td>
              )}

              {hideAssignee ? null : (
                <td>
                  {task.assignee ? (
                    <UserChip name={task.assignee.name} color={task.assignee.avatarColor} />
                  ) : (
                    <span className="dim small">Unassigned</span>
                  )}
                </td>
              )}

              <td>
                <PriorityBadge priority={task.priority} />
              </td>

              <td className={`small nowrap${task.isOverdue ? '' : ' muted'}`}>
                {shortDate(task.dueDate)}
              </td>

              <td>
                {canUpdateTask(user, task) ? (
                  <TaskStatusSelect task={task} compact {...(onError ? { onError } : {})} />
                ) : (
                  <StatusBadge status={task.status} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
