/**
 * Create / edit a project.
 *
 * `managerId` is offered only to an admin. A project manager who sends it is
 * rejected in `projects.service.ts` — they can neither hand a project to a
 * colleague nor take one — so hiding the field is a courtesy, not the control.
 */
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL } from '../lib/labels';
import { toDateInputValue } from '../lib/time';
import type { ClientDto, ProjectDto, ProjectStatus } from '../types/api';
import { useAssignableUsers, useClients } from '../hooks/usePickers';
import { useCurrentUser } from '../providers/AuthProvider';
import { Modal } from './ui/Modal';
import { InlineError } from './ui/Feedback';

interface ProjectDialogProps {
  project?: ProjectDto;
  onClose: () => void;
  onSaved: (project: ProjectDto) => void;
}

export const ProjectDialog = ({ project, onClose, onSaved }: ProjectDialogProps): React.JSX.Element => {
  const user = useCurrentUser();
  const editing = project !== undefined;
  const isAdmin = user.role === 'ADMIN';

  const { clients } = useClients(true);
  // Managers only — the picker exists so an admin can create a project on
  // someone's behalf, and `/users/assignable` excludes admins by design.
  const { users } = useAssignableUsers(isAdmin && !editing);

  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [clientId, setClientId] = useState(project?.client.id ?? '');
  const [managerId, setManagerId] = useState('');
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? 'ACTIVE');
  const [startDate, setStartDate] = useState(toDateInputValue(project?.startDate ?? null));
  const [dueDate, setDueDate] = useState(toDateInputValue(project?.dueDate ?? null));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      if (editing) {
        const patch: Record<string, unknown> = {};
        if (name !== project.name) patch.name = name.trim();
        if (description !== (project.description ?? '')) patch.description = description.trim() || null;
        if (clientId !== project.client.id) patch.clientId = clientId;
        if (status !== project.status) patch.status = status;
        if (startDate !== toDateInputValue(project.startDate)) patch.startDate = startDate || null;
        if (dueDate !== toDateInputValue(project.dueDate)) patch.dueDate = dueDate || null;

        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }

        const result = await api.patch<{ project: ProjectDto }>(`/projects/${project.id}`, patch);
        onSaved(result.project);
      } else {
        const result = await api.post<{ project: ProjectDto }>('/projects', {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          clientId,
          ...(isAdmin && managerId ? { managerId } : {}),
          status,
          ...(startDate ? { startDate } : {}),
          ...(dueDate ? { dueDate } : {}),
        });
        onSaved(result.project);
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFieldErrors(caught.fieldErrors());
      } else {
        setError('Could not save the project.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={editing ? 'Edit project' : 'New project'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form="project-form"
            className="btn btn-primary"
            disabled={busy || !name.trim() || !clientId}
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create project'}
          </button>
        </>
      }
    >
      <form id="project-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        {error ? (
          <div className="span-2">
            <InlineError message={error} />
          </div>
        ) : null}

        <label className="field span-2">
          <span className="label">Name</span>
          <input
            className="input"
            value={name}
            maxLength={140}
            required
            onChange={(event) => setName(event.target.value)}
          />
          {fieldErrors.name ? <span className="field-error">{fieldErrors.name}</span> : null}
        </label>

        <label className="field span-2">
          <span className="label">Description</span>
          <textarea
            className="textarea"
            rows={3}
            value={description}
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="label">Client</span>
          <select
            className="select"
            value={clientId}
            required
            onChange={(event) => setClientId(event.target.value)}
          >
            <option value="">Select a client…</option>
            {clients.map((client: ClientDto) => (
              <option key={client.id} value={client.id}>
                {client.name}
                {client.company ? ` · ${client.company}` : ''}
              </option>
            ))}
          </select>
          {fieldErrors.clientId ? <span className="field-error">{fieldErrors.clientId}</span> : null}
        </label>

        <label className="field">
          <span className="label">Status</span>
          <select
            className="select"
            value={status}
            onChange={(event) => setStatus(event.target.value as ProjectStatus)}
          >
            {PROJECT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {PROJECT_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="label">Start date</span>
          <input
            className="input"
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
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

        {isAdmin && !editing ? (
          <label className="field">
            <span className="label">Project manager</span>
            <select className="select" value={managerId} onChange={(event) => setManagerId(event.target.value)}>
              <option value="">Me ({user.name})</option>
              {users
                .filter((person) => person.role === 'PROJECT_MANAGER')
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
            </select>
            {fieldErrors.managerId ? <span className="field-error">{fieldErrors.managerId}</span> : null}
          </label>
        ) : null}
      </form>
    </Modal>
  );
};
