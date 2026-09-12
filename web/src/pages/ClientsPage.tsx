/**
 * Clients.
 *
 * Readable by an admin and by project managers — a PM has to pick a client when
 * creating a project, so refusing them the list would break that form. Writes
 * are admin-only, enforced by `requireRole(ADMIN)` on the route and again by
 * `assertCanManage()` in the service.
 *
 * `projectCount` is scoped to the caller: a PM sees how many of *their* projects
 * belong to a client, and `totalProjectCount` arrives as `null` so the list
 * cannot be used to infer the size of someone else's portfolio.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api, toQuery } from '../lib/api';
import { plural } from '../lib/labels';
import { absoluteDate } from '../lib/time';
import { canManageClients } from '../lib/permissions';
import { useApiQuery } from '../hooks/useApiQuery';
import { useCurrentUser } from '../providers/AuthProvider';
import type { ClientDto, Paged } from '../types/api';
import { Modal } from '../components/ui/Modal';
import { EmptyState, ErrorState, InlineError, LoadingRows } from '../components/ui/Feedback';

/* ------------------------------------------------------------------ *
 * Create / edit
 * ------------------------------------------------------------------ */

const ClientDialog = ({
  client,
  onClose,
  onSaved,
}: {
  client?: ClientDto;
  onClose: () => void;
  onSaved: (client: ClientDto) => void;
}): React.JSX.Element => {
  const editing = client !== undefined;

  const [name, setName] = useState(client?.name ?? '');
  const [company, setCompany] = useState(client?.company ?? '');
  const [contactName, setContactName] = useState(client?.contactName ?? '');
  const [contactEmail, setContactEmail] = useState(client?.contactEmail ?? '');

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
        // An emptied optional field is `null`, not `''` — the column is
        // nullable and "" would be a second way to say "unknown".
        const patch: Record<string, unknown> = {};
        if (name.trim() !== client.name) patch.name = name.trim();
        if (company.trim() !== (client.company ?? '')) patch.company = company.trim() || null;
        if (contactName.trim() !== (client.contactName ?? '')) patch.contactName = contactName.trim() || null;
        if (contactEmail.trim() !== (client.contactEmail ?? '')) patch.contactEmail = contactEmail.trim() || null;

        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }

        const result = await api.patch<{ client: ClientDto }>(`/clients/${client.id}`, patch);
        onSaved(result.client);
      } else {
        const result = await api.post<{ client: ClientDto }>('/clients', {
          name: name.trim(),
          ...(company.trim() ? { company: company.trim() } : {}),
          ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
          ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
        });
        onSaved(result.client);
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFieldErrors(caught.fieldErrors());
      } else {
        setError('Could not save the client.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? `Edit ${client.name}` : 'New client'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form="client-form"
            className="btn btn-primary"
            disabled={busy || !name.trim()}
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create client'}
          </button>
        </>
      }
    >
      <form id="client-form" className="col gap-4" onSubmit={(event) => void submit(event)}>
        {error ? <InlineError message={error} /> : null}

        <label className="field">
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

        <label className="field">
          <span className="label">Company</span>
          <input
            className="input"
            value={company}
            maxLength={140}
            onChange={(event) => setCompany(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="label">Contact name</span>
          <input
            className="input"
            value={contactName}
            maxLength={120}
            onChange={(event) => setContactName(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="label">Contact email</span>
          <input
            className="input"
            type="email"
            value={contactEmail}
            maxLength={255}
            onChange={(event) => setContactEmail(event.target.value)}
          />
          {fieldErrors.contactEmail ? (
            <span className="field-error">{fieldErrors.contactEmail}</span>
          ) : null}
        </label>
      </form>
    </Modal>
  );
};

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export const ClientsPage = (): React.JSX.Element => {
  const user = useCurrentUser();
  const canManage = canManageClients(user);
  const [params, setParams] = useSearchParams();

  const q = params.get('q') ?? '';
  const includeArchived = params.get('includeArchived') === 'true';

  const [search, setSearch] = useState(q);
  const [editing, setEditing] = useState<ClientDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, error, loading, refetch, setData } = useApiQuery<Paged<ClientDto>>(
    `/clients${toQuery({ q, includeArchived: includeArchived ? 'true' : null, limit: 200 })}`,
  );

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const replaceRow = (updated: ClientDto): void => {
    setData((current) =>
      current
        ? { ...current, items: current.items.map((item) => (item.id === updated.id ? updated : item)) }
        : current,
    );
  };

  const setArchived = async (client: ClientDto, isArchived: boolean): Promise<void> => {
    setBusyId(client.id);
    setActionError(null);
    try {
      const result = await api.patch<{ client: ClientDto }>(`/clients/${client.id}`, { isArchived });
      // Archiving removes the row from the default filter, so the local patch
      // only holds while archived rows are on screen.
      if (includeArchived) replaceRow(result.client);
      else refetch();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not update the client.');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Only ever offered for a client with no projects: `Project.clientId` is
   * `onDelete: Restrict`, and the API answers 409 rather than cascading away
   * somebody's project history.
   */
  const remove = async (client: ClientDto): Promise<void> => {
    setBusyId(client.id);
    setActionError(null);
    try {
      await api.delete<void>(`/clients/${client.id}`);
      refetch();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not delete the client.');
    } finally {
      setBusyId(null);
    }
  };

  const clients = data?.items ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Clients</h1>
          <p className="page-subtitle">
            {canManage
              ? 'Every account the agency delivers work for.'
              : 'The clients you can assign a new project to.'}
          </p>
        </div>
        {canManage ? (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            New client
          </button>
        ) : null}
      </header>

      <div className="filters">
        <div className="filter-group grow">
          <label className="label" htmlFor="client-search">
            Search
          </label>
          <input
            id="client-search"
            className="input"
            value={search}
            placeholder="Name, company or contact"
            onChange={(event) => setSearch(event.target.value)}
            onBlur={() => update('q', search.trim())}
            onKeyDown={(event) => {
              if (event.key === 'Enter') update('q', search.trim());
            }}
          />
        </div>

        <label className="checkbox" style={{ paddingBottom: 8 }}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => update('includeArchived', event.target.checked ? 'true' : '')}
          />
          Show archived
        </label>
      </div>

      {actionError ? <InlineError message={actionError} /> : null}

      <section className="card card-flush">
        {error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : loading && clients.length === 0 ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <LoadingRows rows={5} height={44} />
          </div>
        ) : clients.length === 0 ? (
          <EmptyState
            title="No clients"
            hint={
              q
                ? 'Nothing matches that search.'
                : canManage
                  ? 'Add one to start a project.'
                  : 'An admin has not set up any clients yet.'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Contact</th>
                  <th>{user.role === 'ADMIN' ? 'Projects' : 'My projects'}</th>
                  <th>Added</th>
                  {canManage ? <th aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.id} style={client.isArchived ? { opacity: 0.55 } : undefined}>
                    <td>
                      <div className="row gap-2">
                        <span className="strong truncate">{client.name}</span>
                        {client.isArchived ? (
                          <span className="badge badge-plain badge-neutral">Archived</span>
                        ) : null}
                      </div>
                      {client.company ? <div className="tiny dim truncate">{client.company}</div> : null}
                    </td>

                    <td className="small">
                      {client.contactName ?? <span className="dim">No contact</span>}
                      {client.contactEmail ? (
                        <div className="tiny">
                          <a href={`mailto:${client.contactEmail}`} className="muted">
                            {client.contactEmail}
                          </a>
                        </div>
                      ) : null}
                    </td>

                    <td className="small">
                      {client.projectCount > 0 ? (
                        <Link to={`/projects${toQuery({ clientId: client.id })}`} className="muted">
                          {plural(client.projectCount, 'project')}
                        </Link>
                      ) : (
                        <span className="dim">None</span>
                      )}
                    </td>

                    <td className="small muted nowrap">{absoluteDate(client.createdAt)}</td>

                    {canManage ? (
                      <td>
                        <div className="row gap-2">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busyId === client.id}
                            onClick={() => setEditing(client)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            disabled={busyId === client.id}
                            onClick={() => void setArchived(client, !client.isArchived)}
                          >
                            {client.isArchived ? 'Restore' : 'Archive'}
                          </button>
                          {client.totalProjectCount === 0 ? (
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              disabled={busyId === client.id}
                              onClick={() => void remove(client)}
                            >
                              Delete
                            </button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {creating ? (
        <ClientDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            refetch();
          }}
        />
      ) : null}

      {editing ? (
        <ClientDialog
          client={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(null);
            replaceRow(updated);
          }}
        />
      ) : null}
    </div>
  );
};
