/**
 * Status board.
 *
 * Four columns, one per `TaskStatus`, grouped in the browser from a single
 * `GET /tasks?projectId=…` — four separate requests would give four separate
 * snapshots, and a task moving between two of them could briefly appear in both
 * or neither.
 *
 * Cards are not drag-and-drop. A developer may only move a task as far as In
 * Review, and a dragged card that springs back because the API said 403 is a
 * worse experience than a dropdown that never offered the illegal move. The
 * status control on the card is the same `TaskStatusSelect` the table uses, so
 * there is one code path for changing status.
 */
import { useNavigate } from 'react-router-dom';
import type { TaskDto } from '../types/api';
import { TASK_STATUSES } from '../types/api';
import { STATUS_LABEL, STATUS_SLUG } from '../lib/labels';
import { dueLabel } from '../lib/time';
import { canUpdateTask } from '../lib/permissions';
import { useCurrentUser } from '../providers/AuthProvider';
import { Avatar } from './ui/Avatar';
import { OverdueBadge, PriorityBadge } from './ui/Badges';
import { TaskStatusSelect } from './TaskStatusSelect';

const TaskCard = ({
  task,
  highlighted,
  onError,
}: {
  task: TaskDto;
  highlighted: boolean;
  onError?: (message: string) => void;
}): React.JSX.Element => {
  const user = useCurrentUser();
  const navigate = useNavigate();

  return (
    <div
      className={`task-card${highlighted ? ' just-changed' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/tasks/${task.id}`)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          navigate(`/tasks/${task.id}`);
        }
      }}
    >
      <div className="row-between">
        <span className="task-number">#{task.number}</span>
        <PriorityBadge priority={task.priority} />
      </div>

      <span className="task-card-title clamp-2">{task.title}</span>

      <div className="task-card-foot">
        <span className="row gap-2" style={{ minWidth: 0 }}>
          {task.assignee ? (
            <Avatar name={task.assignee.name} color={task.assignee.avatarColor} size="sm" />
          ) : (
            <span className="tiny dim">Unassigned</span>
          )}
          {task.isOverdue ? (
            <OverdueBadge />
          ) : task.dueDate ? (
            <span className="tiny dim nowrap">{dueLabel(task.dueDate)}</span>
          ) : null}
        </span>

        {canUpdateTask(user, task) ? (
          <TaskStatusSelect task={task} compact {...(onError ? { onError } : {})} />
        ) : null}
      </div>
    </div>
  );
};

export const TaskBoard = ({
  tasks,
  highlighted,
  onError,
}: {
  tasks: TaskDto[];
  highlighted?: ReadonlySet<string>;
  onError?: (message: string) => void;
}): React.JSX.Element => {
  const columns = TASK_STATUSES.map((status) => ({
    status,
    items: tasks.filter((task) => task.status === status),
  }));

  return (
    <div className="board">
      {columns.map((column) => (
        <section className="board-column" key={column.status} aria-label={STATUS_LABEL[column.status]}>
          <header className="board-column-head">
            <span className="board-column-title">
              <span className={`status-dot status-${STATUS_SLUG[column.status]}`} aria-hidden="true" />
              {STATUS_LABEL[column.status]}
            </span>
            <span className="board-column-count">{column.items.length}</span>
          </header>

          {column.items.length === 0 ? (
            <p className="tiny dim" style={{ padding: 'var(--space-2)' }}>
              Nothing here.
            </p>
          ) : (
            column.items.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                highlighted={Boolean(highlighted?.has(task.id))}
                {...(onError ? { onError } : {})}
              />
            ))
          )}
        </section>
      ))}
    </div>
  );
};
