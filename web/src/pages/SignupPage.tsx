/**
 * Create an account.
 *
 * Deliberately has **no role selector**. Every account created here is a
 * Developer, and that is decided on the server — `registerSchema` does not accept
 * a role and `register()` writes the constant. A select box here would be
 * cosmetic at best and, if the API trusted it, a way for anyone to make
 * themselves an admin.
 *
 * Saying so on screen is the honest thing: a new user who expected to be a
 * manager should find out now, not after wondering why half the navigation is
 * missing.
 */
import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../providers/AuthProvider';
import { InlineError } from '../components/ui/Feedback';
import { ThemeToggle } from '../components/ThemeToggle';

/** Kept in step with `passwordSchema`, so the rule shows before the round trip. */
const PASSWORD_RULE = 'At least 10 characters, with an uppercase letter, a lowercase letter and a digit.';

const passwordLooksValid = (value: string): boolean =>
  value.length >= 10 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);

export const SignupPage = (): React.JSX.Element => {
  const { register, status } = useAuth();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const passwordOk = passwordLooksValid(password);
  const canSubmit = !busy && email.trim() !== '' && name.trim() !== '' && passwordOk;

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;

    setBusy(true);
    setError(null);
    setFieldErrors({});

    void (async () => {
      try {
        await register({
          email: email.trim(),
          name: name.trim(),
          password,
          ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
        });
        // On success the provider flips `status` to authenticated and the
        // redirect at the top of this component takes over.
      } catch (caught) {
        if (caught instanceof ApiError) {
          setError(
            caught.status === 429
              ? 'Too many sign-up attempts from this network. Try again later.'
              : caught.message,
          );
          setFieldErrors(caught.fieldErrors());
        } else {
          setError('Could not reach the server.');
        }
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            V
          </span>
          <div>
            <h1 style={{ fontSize: 19 }}>Create an account</h1>
            <div className="small muted">Join the Velozity dashboard</div>
          </div>
          <ThemeToggle />
        </div>

        {error ? <InlineError message={error} /> : null}

        <div className="field">
          <label className="label" htmlFor="signup-name">
            Full name
          </label>
          <input
            id="signup-name"
            className="input"
            autoComplete="name"
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ravi Verma"
          />
          {fieldErrors.name ? <span className="field-error">{fieldErrors.name}</span> : null}
        </div>

        <div className="field">
          <label className="label" htmlFor="signup-email">
            Email
          </label>
          <input
            id="signup-email"
            className="input"
            type="email"
            autoComplete="username"
            required
            maxLength={255}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@velozity.dev"
          />
          {fieldErrors.email ? <span className="field-error">{fieldErrors.email}</span> : null}
        </div>

        <div className="field">
          <label className="label" htmlFor="signup-job">
            Job title <span className="tiny dim">(optional)</span>
          </label>
          <input
            id="signup-job"
            className="input"
            maxLength={80}
            value={jobTitle}
            onChange={(event) => setJobTitle(event.target.value)}
            placeholder="Frontend Engineer"
          />
          {fieldErrors.jobTitle ? <span className="field-error">{fieldErrors.jobTitle}</span> : null}
        </div>

        <div className="field">
          <label className="label" htmlFor="signup-password">
            Password
          </label>
          <input
            id="signup-password"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            aria-invalid={password !== '' && !passwordOk}
            onChange={(event) => setPassword(event.target.value)}
          />
          <span className={password !== '' && !passwordOk ? 'field-error' : 'tiny dim'}>
            {fieldErrors.password ?? PASSWORD_RULE}
          </span>
        </div>

        <div className="alert alert-info">
          New accounts join as a <strong>Developer</strong> and can see only the tasks assigned to
          them. An administrator can change your role afterwards.
        </div>

        <button type="submit" className="btn btn-primary btn-block" disabled={!canSubmit}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>

        <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
};
