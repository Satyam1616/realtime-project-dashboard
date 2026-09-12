/**
 * Inline status control.
 *
 * `PATCH`es the task and then does *nothing* to the local list: the update
 * comes back through `task:changed` and `activity:new` like everyone else's,
 * so the person who made the change and the four people watching all take the
 * same code path. Optimistically rewriting local state here would mean the
 * actor's screen is updated by one mechanism and every other screen by another
 * — two behaviours to keep in step, and the one place a real-time app tends to
 * drift.
 */
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { STATUS_LABEL } from '../lib/labels';
import { allowedStatusTargets } from '../lib/permissions';
import { useCurrentUser } from '../providers/AuthProvider';
import type { TaskDto, TaskStatus } from '../types/api';

export const TaskStatusSelect = ({
  task,
  onError,
  compact,
}: {
  task: TaskDto;
  onError?: (message: string) => void;
  compact?: boolean;
}): React.JSX.Element => {
  const user = useCurrentUser();
  const [busy, setBusy] = useState(false);

  const targets = allowedStatusTargets(user);
  // A task already Done still shows Done — the option is present because it is
  // the current value, not because this user could set it.
  const options = targets.includes(task.status) ? targets : [task.status, ...targets];

  const change = async (status: TaskStatus): Promise<void> => {
    if (status === task.status) return;
    setBusy(true);
    try {
      await api.patch<{ task: TaskDto }>(`/tasks/${task.id}`, { status });
    } catch (caught) {
      onError?.(caught instanceof ApiError ? caught.message : 'Could not update the task.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <select
      className="select"
      style={compact ? { width: 'auto', padding: '3px 26px 3px 8px', fontSize: 12 } : undefined}
      value={task.status}
      disabled={busy}
      aria-label={`Status of task ${task.number}`}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        event.stopPropagation();
        void change(event.target.value as TaskStatus);
      }}
    >
      {options.map((status) => (
        <option key={status} value={status} disabled={status !== task.status && !targets.includes(status)}>
          {STATUS_LABEL[status]}
        </option>
      ))}
    </select>
  );
};
