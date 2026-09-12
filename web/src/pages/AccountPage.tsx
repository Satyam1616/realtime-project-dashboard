/**
 * Account.
 *
 * Profile fields are read-only here on purpose: name, role and avatar colour
 * are administered from the Team page, and letting someone edit their own role
 * would be the whole permission model undone. What a user owns is their
 * password.
 *
 * Changing it revokes every refresh token the account holds — that is the point
 * of changing it — so this page signs itself out once the server confirms.
 */
import { useEffect, useState } from 'react';
import { ApiError, authApi } from '../lib/api';
import { ROLE_LABEL } from '../lib/labels';
import { useAuth, useCurrentUser } from '../providers/AuthProvider';
import { useSocket } from '../providers/SocketProvider';
import { Avatar } from '../components/ui/Avatar';
import { RoleBadge } from '../components/ui/Badges';
import { InlineError } from '../components/ui/Feedback';

/** Mirrors `passwordSchema` so the rule is visible before the round trip. */
const RULES: ReadonlyArray<{ label: string; test: (value: string) => boolean }> = [
  { label: 'At least 10 characters', test: (value) => value.length >= 10 },
  { label: 'A lowercase letter', test: (value) => /[a-z]/.test(value) },
  { label: 'An uppercase letter', test: (value) => /[A-Z]/.test(value) },
  { label: 'A digit', test: (value) => /[0-9]/.test(value) },
];

export const AccountPage = (): React.JSX.Element => {
  const user = useCurrentUser();
  const { logout } = useAuth();
  const { connected } = useSocket();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const unmet = RULES.filter((rule) => !rule.test(newPassword));
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const ready = currentPassword.length > 0 && unmet.length === 0 && confirmPassword === newPassword;

  // The server has already dropped the refresh cookie; this ends the in-memory
  // half of the session so the app does not sit on a token it cannot renew.
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => void logout(), 2000);
    return () => window.clearTimeout(timer);
  }, [done, logout]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await authApi.changePassword(currentPassword, newPassword);
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.status === 401
            ? 'That current password is not right.'
            : caught.message
          : 'Could not change the password.',
      );
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Account</h1>
          <p className="page-subtitle">Your profile and sign-in details</p>
        </div>
      </header>

      <div className="split">
        <section className="card">
          <header className="card-header">
            <h2 className="card-title">Change password</h2>
          </header>

          {done ? (
            <div className="alert alert-info" role="status">
              Password changed. Every session — including this one — has been signed out; taking you
              to the sign-in page.
            </div>
          ) : (
            <form className="col gap-4" onSubmit={(event) => void submit(event)}>
              {error ? <InlineError message={error} /> : null}

              <label className="field">
                <span className="label">Current password</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  required
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </label>

              <label className="field">
                <span className="label">New password</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  required
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </label>

              {/* Each rule resolves as it is met, rather than one message after
                  a failed submit. */}
              <ul className="col gap-1" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {RULES.map((rule) => {
                  const met = rule.test(newPassword);
                  return (
                    <li key={rule.label} className={met ? 'tiny ok-text' : 'tiny dim'}>
                      <span aria-hidden="true">{met ? '✓' : '·'}</span> {rule.label}
                    </li>
                  );
                })}
              </ul>

              <label className="field">
                <span className="label">Confirm new password</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  required
                  aria-invalid={mismatch}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
                {mismatch ? <span className="field-error">The two entries do not match.</span> : null}
              </label>

              <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
                {busy ? 'Changing…' : 'Change password'}
              </button>
            </form>
          )}
        </section>

        <div className="col gap-5">
          <section className="card">
            <header className="card-header">
              <h2 className="card-title">Profile</h2>
            </header>

            <div className="row gap-3" style={{ marginBottom: 'var(--space-4)' }}>
              <Avatar name={user.name} color={user.avatarColor} size="lg" />
              <div style={{ minWidth: 0 }}>
                <div className="strong truncate">{user.name}</div>
                <div className="tiny dim truncate">{user.email}</div>
              </div>
            </div>

            <div className="detail-grid">
              <span className="detail-key">Role</span>
              <span>
                <RoleBadge role={user.role} />
              </span>

              <span className="detail-key">Title</span>
              <span className={user.jobTitle ? '' : 'dim'}>{user.jobTitle ?? 'Not set'}</span>

              <span className="detail-key">Live feed</span>
              <span className={`conn ${connected ? 'conn-live' : 'conn-down'}`}>
                <span className="conn-dot" />
                {connected ? 'Connected' : 'Reconnecting'}
              </span>
            </div>

            <p className="tiny dim" style={{ marginTop: 'var(--space-4)' }}>
              {user.role === 'ADMIN'
                ? 'As an admin you can change anyone’s name, role or colour from the Team page.'
                : `Your name, role (${ROLE_LABEL[user.role]}) and colour are set by an admin.`}
            </p>
          </section>

          <section className="card">
            <header className="card-header">
              <h2 className="card-title">How this session works</h2>
            </header>
            <ul className="col gap-2 small muted" style={{ paddingLeft: '1.1em', margin: 0 }}>
              <li>
                The access token lives in memory only. Closing the tab discards it — nothing
                sensitive is written to <span className="mono tiny">localStorage</span>.
              </li>
              <li>
                The refresh token is an <span className="mono tiny">HttpOnly</span> cookie, so page
                scripts cannot read it. It is rotated on every use.
              </li>
              <li>Re-using an old refresh token is treated as theft and ends every session.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
};
