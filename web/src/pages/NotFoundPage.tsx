/**
 * 404.
 *
 * Also what `<RequireRole>` renders in place of a route that is not yours,
 * which is why the copy avoids "this page does not exist": for a developer who
 * followed a link to /team, the honest answer is that the route is not theirs,
 * and telling them which is which would describe the shape of the admin UI to
 * someone who cannot use it.
 */
import { Link } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider';

export const NotFoundPage = (): React.JSX.Element => {
  const { user } = useAuth();

  return (
    <div className="page">
      <div className="empty" style={{ paddingTop: 'var(--space-7)' }}>
        <div className="mono dim" style={{ fontSize: 40 }}>
          404
        </div>
        <div className="empty-title">Nothing here</div>
        <p className="small">
          That address does not match anything your account can open.
        </p>
        <Link to={user ? '/' : '/login'} className="btn">
          {user ? 'Back to the dashboard' : 'Sign in'}
        </Link>
      </div>
    </div>
  );
};
