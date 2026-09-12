/**
 * Task detail.
 *
 * The history panel is the brief's "activity log" requirement met literally:
 * every row is a persisted `ActivityEvent` written inside the same transaction
 * as the change it describes. Nothing here is derived from the task's current
 * state — if the log says a task went To Do → In Progress → In Review, those are
 * three rows with three timestamps and three actors, not a reconstruction.
 *
 * The page joins the task's project room so a change made by someone else
 * arrives as `task:changed` while it is open.
 */
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { activityIcon, describeActivity } from '../lib/activity';
import { PRIORITY_LABEL, ROLE_SHORT, STATUS_LABEL } from '../lib/labels';
import { absoluteDate, absoluteDateTime, dueLabel, relativeTime } from '../lib/time';
import { canDeleteTask, canEditTaskFields, canUpdateTask } from '../lib/permissions';
import { useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { useRefetchOnActivity } from '../hooks/useLiveTasks';
import { useProjectRoom, useRealtimeEvent } from '../providers/SocketProvider';
import { useCurrentUser } from '../providers/AuthProvider';
import type { TaskDto } from '../types/api';
import type { ActivityEventDto, TaskChangedDto } from '../types/realtime';
import { TaskDialog } from '../components/TaskDialog';
import { TaskStatusSelect } from '../components/TaskStatusSelect';
import { Avatar } from '../components/ui/Avatar';
import { OverdueBadge, PriorityBadge, StatusBadge } from '../components/ui/Badges';
import { EmptyState, ErrorState, InlineError, LoadingRows } from '../components/ui/Feedback';

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

const TaskHistory = ({ taskId }: { taskId: string }): React.JSX.Element => {
  const now = useNow();
  const { data, error, loading, refetch } = useApiQuery<{ items: ActivityEventDto[] }>(
    `/tasks/${taskId}/activity`,
  );

  // The task's own log, so every event type matters here — including the ones
  // the list views ignore.
  useRefetchOnActivity(refetch);

  const items = data?.items ?? [];

  return (
    <section className="card feed">
      <header className="card-header">
        <h2 className="card-title">History</h2>
        <span className="small dim">Stored, not derived</span>
      </header>

      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : loading && items.length === 0 ? (
        <LoadingRows rows={4} height={40} />
      ) : items.length === 0 ? (
        <EmptyState title="No history yet" />
      ) : (
        <ul className="feed-scroll" style={{ maxHeight: 520, listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((event) => {
            const sentence = describeActivity(event);
            return (
              <li className="feed-item" key={event.id}>
                <span className="feed-icon" aria-hidden="true">
                  {activityIcon(event.type)}
                </span>
                <div className="grow">
                  <div className="feed-text">
                    <span className="feed-actor">{sentence.actor}</span>{' '}
                    {sentence.segments.map((segment, index) => (
                      <span
                        key={index}
                        className={
                          segment.kind === 'strong'
                            ? 'feed-strong'
                            : segment.kind === 'status'
                              ? 'feed-status'
                              : segment.kind === 'muted'
                                ? 'dim'
                                : undefined
                        }
                      >
                        {segment.text}
                      </span>
                    ))}
                  </div>
                  <div className="feed-meta">
                    <time dateTime={event.createdAt} title={absoluteDateTime(event.createdAt)}>
                      {relativeTime(event.createdAt, now)}
                    </time>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export const TaskDetailPage = (): React.JSX.Element => {
  const { id = '' } = useParams<{ id: string }>();
  const user = useCurrentUser();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data, error, loading, refetch, setData } = useApiQuery<{ task: TaskDto }>(
    id ? `/tasks/${id}` : null,
  );
  const task = data?.task;

  // Membership of the project room is what makes `task:changed` arrive.
  useProjectRoom(task?.project.id ?? null);

  /**
   * A single loaded task is the one place where patching from the event is
   * clearly right: the event carries every field on screen except the assignee's
   * colour, and a full re-read would flicker the panel for no gain.
   */
  useRealtimeEvent(
    'task:changed',
    useCallback(
      (event: TaskChangedDto) => {
        if (event.id !== id) return;
        if (event.changeKind === 'deleted') {
          navigate('/tasks', { replace: true });
          return;
        }
        refetch();
      },
      [id, navigate, refetch],
    ),
  );

  const remove = async (): Promise<void> => {
    if (!task) return;
    setDeleting(true);
    try {
      await api.delete<void>(`/tasks/${task.id}`);
      navigate(`/projects/${task.project.id}`, { replace: true });
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not delete the task.');
      setDeleting(false);
    }
  };

  if (error) {
    return (
      <div className="page">
        <ErrorState error={error} onRetry={refetch} />
      </div>
    );
  }
  if (!task) {
    return (
      <div className="page">{loading ? <LoadingRows rows={5} height={72} /> : null}</div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div style={{ minWidth: 0 }}>
          <div className="row gap-3 wrap">
            <span className="task-number">#{task.number}</span>
            <h1 className="truncate">{task.title}</h1>
            {task.isOverdue ? <OverdueBadge /> : null}
          </div>
          <p className="page-subtitle">
            in{' '}
            <Link to={`/projects/${task.project.id}`} className="muted">
              {task.project.name}
            </Link>
          </p>
        </div>

        <div className="row gap-2">
          {canUpdateTask(user, task) ? (
            <TaskStatusSelect task={task} onError={setActionError} />
          ) : (
            <StatusBadge status={task.status} />
          )}
          {canEditTaskFields(user, task) ? (
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          ) : null}
          {canDeleteTask(user, task) ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          ) : null}
        </div>
      </header>

      {actionError ? <InlineError message={actionError} /> : null}

      {/* A developer sees the status control but not the priority or due-date
          fields. Both restrictions are re-applied server-side per field. */}
      {user.role === 'DEVELOPER' ? (
        <p className="small dim">
          You can move this task along the board as far as In Review. Signing it off as Done is the
          project manager's call.
        </p>
      ) : null}

      <div className="split">
        <div className="col gap-5">
          <section className="card">
            <div className="detail-grid">
              <span className="detail-key">Status</span>
              <span>
                <StatusBadge status={task.status} />
              </span>

              <span className="detail-key">Priority</span>
              <span>
                <PriorityBadge priority={task.priority} /> <span className="dim small">{PRIORITY_LABEL[task.priority]}</span>
              </span>

              <span className="detail-key">Assignee</span>
              <span>
                {task.assignee ? (
                  <span className="row gap-2">
                    <Avatar name={task.assignee.name} color={task.assignee.avatarColor} size="sm" />
                    {task.assignee.name}
                    <span className="tiny dim">{task.assignee.email}</span>
                  </span>
                ) : (
                  <span className="dim">Unassigned</span>
                )}
              </span>

              <span className="detail-key">Due</span>
              <span className={task.isOverdue ? 'danger-text strong' : task.dueDate ? '' : 'dim'}>
                {task.dueDate ? `${absoluteDate(task.dueDate)} · ${dueLabel(task.dueDate)}` : 'No deadline'}
              </span>

              <span className="detail-key">Created</span>
              <span className="muted">
                {absoluteDate(task.createdAt)}
                {task.createdBy ? ` by ${task.createdBy.name}` : ''}
              </span>

              {task.completedAt ? (
                <>
                  <span className="detail-key">Completed</span>
                  <span>{absoluteDateTime(task.completedAt)}</span>
                </>
              ) : null}
            </div>
          </section>

          <section className="card">
            <header className="card-header">
              <h2 className="card-title">Description</h2>
            </header>
            {task.description ? (
              <p style={{ whiteSpace: 'pre-wrap' }}>{task.description}</p>
            ) : (
              <p className="dim small">No description.</p>
            )}
          </section>

          <p className="tiny dim">
            {STATUS_LABEL[task.status]} · {ROLE_SHORT[user.role]} view · last updated{' '}
            {absoluteDateTime(task.updatedAt)}
          </p>
        </div>

        <TaskHistory taskId={task.id} />
      </div>

      {editing ? (
        <TaskDialog
          task={task}
          projects={[{ id: task.project.id, name: task.project.name }]}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            setData(() => ({ task: updated }));
          }}
        />
      ) : null}
    </div>
  );
};
