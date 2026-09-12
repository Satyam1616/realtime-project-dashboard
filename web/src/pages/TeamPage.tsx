/**
 * Team — the admin's user directory.
 *
 * Reachable only by an admin, and that is decided twice: the router will not
 * render it for anyone else, and `GET /users` calls `assertAdmin()` before it
 * touches the database. The second check is the one that matters — a developer
 * who types /team into the address bar gets a 403 envelope, not a roster.
 *
 * Nobody is ever deleted here. A user row is referenced by the tasks they
 * created and the activity they performed, so offboarding is `isActive: false`
 * and the history stays readable.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api, toQuery } from '../lib/api';
import { ROLE_LABEL, plural } from '../lib/labels';
import { absoluteDate } from '../lib/time';
import { useApiQuery } from '../hooks/useApiQuery';
import { useCurrentUser } from '../providers/AuthProvider';
import type { Paged, Role, TeamUserDto } from '../types/api';
import { Avatar } from '../components/ui/Avatar';
import { RoleBadge } from '../components/ui/Badges';
import { Modal } from '../components/ui/Modal';
import { EmptyState, ErrorState, InlineError, LoadingRows } from '../components/ui/Feedback';

const ROLES: readonly Role[] = ['ADMIN', 'PROJECT_MANAGER', 'DEVELOPER'];

/** Kept in step with `passwordSchema` so the message appears before the round trip. */
const PASSWORD_RULE = 'At least 10 characters, with an uppercase letter, a lowercase letter and a digit.';
const passwordLooksValid = (value: string): boolean =>
  value.length >= 10 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);

/* ------------------------------------------------------------------ *
 * Create / edit
 * ------------------------------------------------------------------ */

const UserDialog = ({
  user,
  onClose,
  onSaved,
}: {
  user?: TeamUserDto;
  onClose: () => void;
  onSaved: (user: TeamUserDto) => void;
}): React.JSX.Element => {
  const editing = user !== undefined;

  const [email, setEmail] = useState(user?.email ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'DEVELOPER');
  const [jobTitle, setJobTitle] = useState(user?.jobTitle ?? '');
  const [avatarColor, setAvatarColor] = useState(user?.avatarColor ?? '#6366f1');
  const [password, setPassword] = useState('');
  const [isActive, setIsActive] = useState(user?.isActive ?? true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Blank on an edit means "leave it alone"; on a create it is required.
  const passwordOk = editing ? password === '' || passwordLooksValid(password) : passwordLooksValid(password);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      if (editing) {
        const patch: Record<string, unknown> = {};
        if (name.trim() !== user.name) patch.name = name.trim();
        if (role !== user.role) patch.role = role;
        if (jobTitle.trim() !== (user.jobTitle ?? '')) patch.jobTitle = jobTitle.trim() || null;
        if (avatarColor !== user.avatarColor) patch.avatarColor = avatarColor;
        if (isActive !== user.isActive) patch.isActive = isActive;
        if (password) patch.password = password;

        // The API rejects an empty patch, and rightly — but a user who opened
        // the dialog and changed nothing meant "cancel", not "error".
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }

        const result = await api.patch<{ user: TeamUserDto }>(`/users/${user.id}`, patch);
        onSaved(result.user);
      } else {
        const result = await api.post<{ user: TeamUserDto }>('/users', {
          email: email.trim(),
          name: name.trim(),
          password,
          role,
          ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
          avatarColor,
        });
        onSaved(result.user);
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFieldErrors(caught.fieldErrors());
      } else {
        setError('Could not save the user.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={editing ? `Edit ${user.name}` : 'Add a team member'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form="user-form"
            className="btn btn-primary"
            disabled={busy || !name.trim() || (!editing && !email.trim()) || !passwordOk}
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create user'}
          </button>
        </>
      }
    >
      <form id="user-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        {error ? (
          <div className="span-2">
            <InlineError message={error} />
          </div>
        ) : null}

        <label className="field">
          <span className="label">Name</span>
          <input
            className="input"
            value={name}
            maxLength={120}
            required
            onChange={(event) => setName(event.target.value)}
          />
          {fieldErrors.name ? <span className="field-error">{fieldErrors.name}</span> : null}
        </label>

        <label className="field">
          <span className="label">Email</span>
          <input
            className="input"
            type="email"
            value={email}
            maxLength={255}
            required
            /* The address is the login identity and appears on every activity
               row already written; changing it is not offered. */
            disabled={editing}
            onChange={(event) => setEmail(event.target.value)}
          />
          {fieldErrors.email ? <span className="field-error">{fieldErrors.email}</span> : null}
        </label>

        <label className="field">
          <span className="label">Role</span>
          <select className="select" value={role} onChange={(event) => setRole(event.target.value as Role)}>
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABEL[value]}
              </option>
            ))}
          </select>
          {fieldErrors.role ? <span className="field-error">{fieldErrors.role}</span> : null}
        </label>

        <label className="field">
          <span className="label">Job title</span>
          <input
            className="input"
            value={jobTitle}
            maxLength={80}
            placeholder="Frontend Engineer"
            onChange={(event) => setJobTitle(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="label">{editing ? 'Reset password' : 'Password'}</span>
          <input
            className="input"
            type="password"
            value={password}
            autoComplete="new-password"
            placeholder={editing ? 'Leave blank to keep the current one' : ''}
            required={!editing}
            aria-invalid={password !== '' && !passwordLooksValid(password)}
            onChange={(event) => setPassword(event.target.value)}
          />
          <span className={password !== '' && !passwordLooksValid(password) ? 'field-error' : 'tiny dim'}>
            {fieldErrors.password ?? PASSWORD_RULE}
          </span>
        </label>

        <label className="field">
          <span className="label">Avatar colour</span>
          <div className="row gap-3">
            <Avatar name={name || '?'} color={avatarColor} size="lg" />
            <input
              className="input"
              type="color"
              value={avatarColor}
              style={{ width: 64, padding: 3 }}
              onChange={(event) => setAvatarColor(event.target.value)}
            />
            <span className="mono tiny dim">{avatarColor}</span>
          </div>
          {fieldErrors.avatarColor ? <span className="field-error">{fieldErrors.avatarColor}</span> : null}
        </label>

        {editing ? (
          <div className="span-2">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
              />
              Active — an inactive account cannot sign in, and any session it
              already holds is closed immediately.
            </label>
          </div>
        ) : null}

        {editing && password ? (
          <p className="span-2 small dim">
            Resetting the password signs {user.name} out of every device.
          </p>
        ) : null}
      </form>
    </Modal>
  );
};

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export const TeamPage = (): React.JSX.Element => {
  const me = useCurrentUser();
  const [params, setParams] = useSearchParams();

  const role = params.get('role') ?? '';
  const q = params.get('q') ?? '';
  const includeInactive = params.get('includeInactive') === 'true';

  const [search, setSearch] = useState(q);
  const [editing, setEditing] = useState<TeamUserDto | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, error, loading, refetch, setData } = useApiQuery<Paged<TeamUserDto>>(
    `/users${toQuery({ role, q, includeInactive: includeInactive ? 'true' : null, limit: 200 })}`,
  );

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  /** Replace one row in place — the response is the authority on every field. */
  const replaceRow = (updated: TeamUserDto): void => {
    setData((current) =>
      current
        ? { ...current, items: current.items.map((item) => (item.id === updated.id ? updated : item)) }
        : current,
    );
  };

  const users = data?.items ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Team</h1>
          <p className="page-subtitle">
            {data ? plural(data.total, 'person', 'people') : 'Everyone with an account'} · roles decide what
            each of them can reach
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          Add member
        </button>
      </header>

      <div className="filters">
        <div className="filter-group grow">
          <label className="label" htmlFor="team-search">
            Search
          </label>
          <input
            id="team-search"
            className="input"
            value={search}
            placeholder="Name, email or job title"
            onChange={(event) => setSearch(event.target.value)}
            onBlur={() => update('q', search.trim())}
            onKeyDown={(event) => {
              if (event.key === 'Enter') update('q', search.trim());
            }}
          />
        </div>

        <div className="filter-group">
          <label className="label" htmlFor="team-role">
            Role
          </label>
          <select
            id="team-role"
            className="select"
            value={role}
            onChange={(event) => update('role', event.target.value)}
          >
            <option value="">All roles</option>
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABEL[value]}
              </option>
            ))}
          </select>
        </div>

        <label className="checkbox" style={{ paddingBottom: 8 }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => update('includeInactive', event.target.checked ? 'true' : '')}
          />
          Show deactivated
        </label>
      </div>

      <section className="card card-flush">
        {error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : loading && users.length === 0 ? (
          <div style={{ padding: 'var(--space-4)' }}>
            <LoadingRows rows={6} height={44} />
          </div>
        ) : users.length === 0 ? (
          <EmptyState
            title="Nobody matches"
            hint={q || role ? 'Try a wider filter.' : 'Add the first team member to get started.'}
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Open tasks</th>
                  <th>Projects managed</th>
                  <th>Joined</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {users.map((person) => (
                  <tr key={person.id} style={person.isActive ? undefined : { opacity: 0.55 }}>
                    <td>
                      <div className="row gap-3" style={{ minWidth: 0 }}>
                        <Avatar name={person.name} color={person.avatarColor} />
                        <div style={{ minWidth: 0 }}>
                          <div className="row gap-2">
                            <span className="strong truncate">{person.name}</span>
                            {person.id === me.id ? <span className="badge badge-plain badge-accent">You</span> : null}
                            {person.isActive ? null : (
                              <span className="badge badge-plain badge-neutral">Deactivated</span>
                            )}
                          </div>
                          <div className="tiny dim truncate">
                            {person.email}
                            {person.jobTitle ? ` · ${person.jobTitle}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td>
                      <RoleBadge role={person.role} />
                    </td>

                    {/* The two numbers that answer "can I safely deactivate
                        this person?" — both computed server-side. */}
                    <td className="mono">{person.openTasks}</td>
                    <td className="mono">{person.managedProjects}</td>
                    <td className="small muted nowrap">{absoluteDate(person.createdAt)}</td>

                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(person)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {creating ? (
        <UserDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            // A new row can change the total and the ordering, so this is a
            // re-read rather than a local append.
            refetch();
          }}
        />
      ) : null}

      {editing ? (
        <UserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(null);
            // A deactivation drops the row out of the default filter, which
            // only a re-read can reflect.
            if (updated.isActive || includeInactive) replaceRow(updated);
            else refetch();
          }}
        />
      ) : null}
    </div>
  );
};
