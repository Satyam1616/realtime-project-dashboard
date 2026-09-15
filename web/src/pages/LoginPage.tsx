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
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../providers/AuthProvider';
import type { Role } from '../types/api';
import { ROLE_LABEL } from '../lib/labels';
import { InlineError } from '../components/ui/Feedback';

/**
 * Seeded accounts, listed so a reviewer can move between roles quickly. Only
 * the addresses are in source — see `DEMO_PASSWORD` below for the password.
 */
const DEMO_ACCOUNTS: Array<{ email: string; name: string; role: Role; note: string }> = [
  { email: 'priya@velozity.dev', name: 'Priya Sharma', role: 'ADMIN', note: 'sees everything' },
  { email: 'arjun@velozity.dev', name: 'Arjun Mehta', role: 'PROJECT_MANAGER', note: '2 projects' },
  { email: 'neha@velozity.dev', name: 'Neha Kulkarni', role: 'PROJECT_MANAGER', note: '2 projects' },
  { email: 'ravi@velozity.dev', name: 'Ravi Verma', role: 'DEVELOPER', note: 'assigned tasks only' },
];

/**
 * The seeded fixture password, used by the one-click role buttons.
 *
 * Read from the environment so a deployment seeded with a different
 * `SEED_PASSWORD` still gets working buttons — but **validated first**. Vite
 * inlines this value at build time from a hosting provider's environment form,
 * which is trivially easy to paste the wrong thing into; an unusable value has
 * to degrade to "fill the email in and let them type" rather than submit
 * rubbish and produce a 400 that reads like the app is broken.
 *
 * The fallback is the same literal `server/src/config/env.ts` defaults
 * `SEED_PASSWORD` to. That is fixture data — published in the README, printed by
 * the seed script, and only ever attached to demo accounts in a throwaway
 * database. It is not a secret, and treating it as one would mean the demo
 * cannot work. The actual secrets — `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
 * `DATABASE_URL` — have no default anywhere and the server refuses to boot
 * without them.
 */
const FIXTURE_PASSWORD = 'Password123!';

const readDemoPassword = (): string => {
  const raw: unknown = import.meta.env.VITE_DEMO_PASSWORD;
  if (typeof raw !== 'string') return FIXTURE_PASSWORD;

  const trimmed = raw.trim();
  // A plausible password is one line, unspaced, and inside bcrypt's 72-byte
  // effective input. Anything else is a mis-paste, and the fixture value is a
  // better guess than what was pasted.
  const plausible = trimmed.length > 0 && trimmed.length <= 72 && !/\s/.test(trimmed);
  return plausible ? trimmed : FIXTURE_PASSWORD;
};

const DEMO_PASSWORD = readDemoPassword();

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

        <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>
          New here? <Link to="/signup">Create an account</Link>
        </p>

        <div className="demo-accounts">
          <div className="tiny dim" style={{ padding: '0 7px 4px' }}>
            Demo accounts — click to sign in
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
                void attempt(account.email, DEMO_PASSWORD);
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
