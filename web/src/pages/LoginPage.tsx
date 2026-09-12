/**
 * Sign-in.
 *
 * The access token returned here is held in memory by `lib/api.ts`; the refresh
 * token never reaches JavaScript at all — it arrives as an `HttpOnly` cookie
 * and is replayed by the browser. That is why this page has no "remember me":
 * the cookie *is* the remembering, and a reload restores the session through
 * `POST /auth/refresh` without the password.
 */
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../providers/AuthProvider';
import type { Role } from '../types/api';
import { ROLE_LABEL } from '../lib/labels';
import { InlineError } from '../components/ui/Feedback';

/**
 * Seeded accounts, listed so a reviewer can move between roles quickly. Only
 * the addresses are in source — the shared password comes from the
 * environment, and without it these are just labels.
 */
const DEMO_ACCOUNTS: Array<{ email: string; name: string; role: Role; note: string }> = [
  { email: 'priya@velozity.dev', name: 'Priya Sharma', role: 'ADMIN', note: 'sees everything' },
  { email: 'arjun@velozity.dev', name: 'Arjun Mehta', role: 'PROJECT_MANAGER', note: '3 projects' },
  { email: 'neha@velozity.dev', name: 'Neha Kulkarni', role: 'PROJECT_MANAGER', note: '1 project' },
  { email: 'ravi@velozity.dev', name: 'Ravi Verma', role: 'DEVELOPER', note: 'assigned tasks only' },
];

const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD ?? '';

export const LoginPage = (): React.JSX.Element => {
  const { login, status, endedReason } = useAuth();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  const attempt = async (withEmail: string, withPassword: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await login(withEmail, withPassword);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : caught.message
          : 'Could not reach the server.',
      );
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void attempt(email.trim(), password);
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            V
          </span>
          <div>
            <h1 style={{ fontSize: 19 }}>Velozity</h1>
            <div className="small muted">Client project dashboard</div>
          </div>
        </div>

        {endedReason === 'expired' ? (
          <div className="alert alert-info">Your session expired. Sign in again to continue.</div>
        ) : null}
        {endedReason === 'revoked' ? (
          <div className="alert alert-warn">This session was ended by an administrator.</div>
        ) : null}

        {error ? <InlineError message={error} /> : null}

        <div className="field">
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@velozity.dev"
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <div className="demo-accounts">
          <div className="tiny dim" style={{ padding: '0 7px 4px' }}>
            {DEMO_PASSWORD ? 'Demo accounts — click to sign in' : 'Seeded demo accounts'}
          </div>
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              className="demo-account"
              disabled={busy}
              onClick={() => {
                setEmail(account.email);
                setPassword(DEMO_PASSWORD);
                if (DEMO_PASSWORD) void attempt(account.email, DEMO_PASSWORD);
              }}
            >
              <span className="truncate">
                <span className="strong">{ROLE_LABEL[account.role]}</span> · {account.email}
              </span>
              <span className="tiny dim nowrap">{account.note}</span>
            </button>
          ))}
        </div>
      </form>
    </div>
  );
};
