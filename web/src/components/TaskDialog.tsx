/**
 * Create / edit a task.
 *
 * Two things worth pointing out:
 *
 * - The field set is chosen by role. A developer never opens this dialog at
 *   all; a manager editing a task in another manager's project cannot either,
 *   because the button that opens it is not rendered. Both of those are
 *   cosmetic — `assertCanUpdateTask` in rbac.ts is what actually refuses the
 *   request, and this dialog surfaces that refusal like any other error.
 *
 * - On success it does **not** merge the response into the caller's list. The
 *   `task:changed` / `activity:new` fanout does that, for the author and for
 *   everyone else watching, so there is one path for a task appearing. The
 *   `onSaved` callback exists only to close the dialog and nudge a refetch for
 *   the case where the new task falls outside the author's current filter.
 */
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { PRIORITY_LABEL, ROLE_SHORT, STATUS_LABEL } from '../lib/labels';
import { toDateInputValue } from '../lib/time';
import { TASK_PRIORITIES, TASK_STATUSES } from '../types/api';
import type { AssignableUserDto, ProjectDto, TaskDto, TaskPriority, TaskStatus } from '../types/api';
import { useAssignableUsers } from '../hooks/usePickers';
import { Modal } from './ui/Modal';
import { InlineError } from './ui/Feedback';

interface TaskDialogProps {
  /** Omitted when creating. */
  task?: TaskDto;
  /** Selectable projects; a single-element list renders as a fixed label. */
  projects: Array<Pick<ProjectDto, 'id' | 'name'>>;
  /** Pre-selected project, for "New task" opened from a project page. */
  projectId?: string;
  onClose: () => void;
  onSaved: (task: TaskDto) => void;
}

export const TaskDialog = ({
  task,
  projects,
  projectId,
  onClose,
  onSaved,
}: TaskDialogProps): React.JSX.Element => {
  const editing = task !== undefined;

  const [project, setProject] = useState(task?.project.id ?? projectId ?? projects[0]?.id ?? '');
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [assigneeId, setAssigneeId] = useState(task?.assignee?.id ?? '');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'TODO');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'MEDIUM');
  const [dueDate, setDueDate] = useState(toDateInputValue(task?.dueDate ?? null));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Scoped to the chosen project so the picker offers its members first; the
  // server still validates that the assignee is a real, active, non-admin user.
  const { users } = useAssignableUsers(true, project || undefined);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      if (editing) {
        // Only changed fields are sent. A `PATCH` carrying `priority` from a
        // role that may not set it is a 403 naming the field, so sending
        // untouched values would turn a no-op edit into a denial.
        const patch: Record<string, unknown> = {};
        if (title !== task.title) patch.title = title.trim();
        if (description !== (task.description ?? '')) patch.description = description.trim() || null;
        if (assigneeId !== (task.assignee?.id ?? '')) patch.assigneeId = assigneeId || null;
        if (status !== task.status) patch.status = status;
        if (priority !== task.priority) patch.priority = priority;
        if (dueDate !== toDateInputValue(task.dueDate)) patch.dueDate = dueDate || null;

        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }

        const result = await api.patch<{ task: TaskDto }>(`/tasks/${task.id}`, patch);
        onSaved(result.task);
      } else {
        const result = await api.post<{ task: TaskDto }>('/tasks', {
          projectId: project,
          title: title.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(assigneeId ? { assigneeId } : {}),
          status,
          priority,
          ...(dueDate ? { dueDate } : {}),
        });
        onSaved(result.task);
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFieldErrors(caught.fieldErrors());
      } else {
        setError('Could not save the task.');
      }
    } finally {
      setBusy(false);
    }
  };

  const projectName = projects.find((item) => item.id === project)?.name ?? task?.project.name;

  return (
    <Modal
      wide
      title={editing ? `Edit task #${task.number}` : 'New task'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="task-form" className="btn btn-primary" disabled={busy || !title.trim() || !project}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create task'}
          </button>
        </>
      }
    >
      <form id="task-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        {error ? (
          <div className="span-2">
            <InlineError message={error} />
          </div>
        ) : null}

        <label className="field span-2">
          <span className="label">Title</span>
          <input
            className="input"
            value={title}
            maxLength={180}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
          {fieldErrors.title ? <span className="field-error">{fieldErrors.title}</span> : null}
        </label>

        <label className="field span-2">
          <span className="label">Description</span>
          <textarea
            className="textarea"
            rows={4}
            value={description}
            maxLength={5000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="label">Project</span>
          {editing || projects.length <= 1 ? (
            <input className="input" value={projectName ?? ''} readOnly disabled />
          ) : (
            <select className="select" value={project} onChange={(event) => setProject(event.target.value)}>
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
          {fieldErrors.projectId ? <span className="field-error">{fieldErrors.projectId}</span> : null}
        </label>

        <label className="field">
          <span className="label">Assignee</span>
          <select className="select" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
            <option value="">Unassigned</option>
            {users.map((person: AssignableUserDto) => (
              <option key={person.id} value={person.id}>
                {person.name} · {ROLE_SHORT[person.role]}
              </option>
            ))}
          </select>
          {fieldErrors.assigneeId ? <span className="field-error">{fieldErrors.assigneeId}</span> : null}
        </label>

        <label className="field">
          <span className="label">Status</span>
          <select
            className="select"
            value={status}
            onChange={(event) => setStatus(event.target.value as TaskStatus)}
          >
            {TASK_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="label">Priority</span>
          <select
            className="select"
            value={priority}
            onChange={(event) => setPriority(event.target.value as TaskPriority)}
          >
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {PRIORITY_LABEL[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="label">Due date</span>
          <input
            className="input"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
          {fieldErrors.dueDate ? <span className="field-error">{fieldErrors.dueDate}</span> : null}
        </label>
      </form>
    </Modal>
  );
};
