/**
 * The route table and the two guards in front of it.
 *
 * Neither guard is access control. `RequireAuth` exists so a signed-out visitor
 * lands on the login form instead of a page that fires six requests and renders
 * six 401 panels; `RequireRole` exists so a developer who follows a stale link
 * to /team gets one honest "not yours" instead of a screenful of 403s. Both
 * rules are enforced again — independently, from the token, on the server — by
 * `server/src/access/rbac.ts` for every request the pages behind them make.
 * Deleting this file would make the app unpleasant and no less secure.
 *
 * Provider order is load-bearing: `SocketProvider` reads the access token and
 * the session status from `AuthProvider`, and `NotificationProvider` gets its
 * unread count from the socket rather than from polling, so it has to sit
 * inside both. The router is innermost because none of the three needs a
 * route — which also means a navigation never tears down the WebSocket.
 */
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
  useRouteError,
} from 'react-router-dom';
import type { Role } from './types/api';
import { AuthProvider, useAuth } from './providers/AuthProvider';
import { SocketProvider } from './providers/SocketProvider';
import { NotificationProvider } from './providers/NotificationProvider';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/ui/Feedback';
import { AccountPage } from './pages/AccountPage';
import { ActivityPage } from './pages/ActivityPage';
import { ClientsPage } from './pages/ClientsPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TasksPage } from './pages/TasksPage';
import { TeamPage } from './pages/TeamPage';

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

/**
 * Held while `bootstrapSession()` decides whether the `HttpOnly` refresh cookie
 * still buys a session. That is one request on a reload, and rendering the
 * login form underneath it would flash "signed out" at somebody who is not.
 */
const BootSplash = (): React.JSX.Element => (
  <div className="login-page">
    <div className="col gap-3" style={{ alignItems: 'center' }}>
      <Spinner />
      <span className="small dim">Restoring your session…</span>
    </div>
  </div>
);

const RequireAuth = (): React.JSX.Element => {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <BootSplash />;

  if (status === 'anonymous') {
    // Carried through the sign-in so the original destination resumes,
    // query string included: a link passed between colleagues is usually
    // `/tasks?status=IN_REVIEW&priority=CRITICAL`, and the filters are the
    // interesting half of it. `LoginPage` reads this back off `location.state`.
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }

  return <Outlet />;
};

/**
 * Renders the 404 in place instead of redirecting to it.
 *
 * The address bar keeps the URL that was refused, so a reload says the same
 * thing and Back goes where the user expects rather than bouncing off a
 * redirect. It also keeps the refusal quiet: a redirect to a distinct
 * "forbidden" route would let anyone map the admin surface by watching which
 * paths bounce and which 404 outright.
 */
const RequireRole = ({ roles }: { roles: readonly Role[] }): React.JSX.Element => {
  const { user } = useAuth();

  // Unreachable in practice — `RequireAuth` is always above this in the tree.
  // Present because the context type admits `null`, and a spinner is a kinder
  // answer to a routing mistake than a thrown error.
  if (!user) return <BootSplash />;

  return roles.includes(user.role) ? <Outlet /> : <NotFoundPage />;
};

/**
 * The last stop for a render-time exception.
 *
 * The message deliberately is not the error. A stack trace on screen is the
 * client-side version of the thing the API takes care not to do, and it is no
 * use to the person reading it; the console keeps the detail for whoever is
 * actually debugging.
 */
const RouteError = (): React.JSX.Element => {
  const error = useRouteError();
  console.error('Unhandled route error', error);

  return (
    <div className="login-page">
      <div className="login-card" style={{ textAlign: 'center' }}>
        <div className="empty-title">This page stopped working</div>
        <p className="small muted">
          Something in the interface threw an error. Reloading usually clears it — nothing you have
          saved is affected.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * Two pathless layout routes do the work: `RequireAuth` decides whether
 * anything below it renders at all, and `AppShell` supplies the chrome for
 * everything that does. Role-restricted pages sit under a third so the
 * restriction is declared next to the route rather than repeated inside the
 * page component.
 *
 * `/login` is outside both — it is the one route an anonymous visitor is
 * allowed to reach, and it redirects itself away once a session exists.
 */
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },

          { path: 'projects', element: <ProjectsPage /> },
          { path: 'projects/:id', element: <ProjectDetailPage /> },
          { path: 'tasks', element: <TasksPage /> },
          { path: 'tasks/:id', element: <TaskDetailPage /> },
          { path: 'activity', element: <ActivityPage /> },
          { path: 'account', element: <AccountPage /> },

          {
            element: <RequireRole roles={['ADMIN', 'PROJECT_MANAGER']} />,
            children: [{ path: 'clients', element: <ClientsPage /> }],
          },
          {
            element: <RequireRole roles={['ADMIN']} />,
            children: [{ path: 'team', element: <TeamPage /> }],
          },

          // Inside the shell on purpose: an unknown URL from a signed-in user
          // is a wrong turn, not an ejection, so the navigation stays put.
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

export const App = (): React.JSX.Element => (
  <AuthProvider>
    <SocketProvider>
      <NotificationProvider>
        <RouterProvider router={router} />
      </NotificationProvider>
    </SocketProvider>
  </AuthProvider>
);
