import type { ReactNode } from 'react';
import type { ApiError } from '../../lib/api';

export const Spinner = (): React.JSX.Element => <span className="spinner" role="status" aria-label="Loading" />;

/** Placeholder rows sized like the content they stand in for. */
export const LoadingRows = ({ rows = 4, height = 44 }: { rows?: number; height?: number }): React.JSX.Element => (
  <div className="col gap-2" aria-busy="true" aria-live="polite">
    {Array.from({ length: rows }, (_, index) => (
      <div key={index} className="skeleton" style={{ height }} />
    ))}
  </div>
);

export const EmptyState = ({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): React.JSX.Element => (
  <div className="empty">
    <div className="empty-title">{title}</div>
    {hint ? <div className="small">{hint}</div> : null}
    {action}
  </div>
);

/**
 * A failed request.
 *
 * Shows the server's `message` — which is safe by construction: the API returns
 * a structured envelope and never a stack trace. A 403 gets friendlier wording
 * than "FORBIDDEN" because being denied is a normal outcome in a role-based
 * app, not a malfunction.
 */
export const ErrorState = ({ error, onRetry }: { error: ApiError; onRetry?: () => void }): React.JSX.Element => {
  const denied = error.status === 403 || error.status === 404;

  return (
    <div className="empty">
      <div className="empty-title">{denied ? 'Not available to your role' : 'Something went wrong'}</div>
      <div className="small">
        {denied
          ? 'This item either does not exist or is outside what your account can see.'
          : error.message}
      </div>
      {onRetry && !denied ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
};

export const InlineError = ({ message }: { message: string }): React.JSX.Element => (
  <div className="alert alert-error" role="alert">
    {message}
  </div>
);
