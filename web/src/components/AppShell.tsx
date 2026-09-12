/**
 * The signed-in chrome: brand, role-aware navigation, live indicator, bell,
 * user menu.
 *
 * Navigation is filtered by role purely so people are not shown doors they
 * cannot open. It is *not* the access control — every one of these routes is
 * enforced server-side, and typing the URL of a hidden page returns the same
 * 403 the menu implies. See README.md, "Role-based access".
 */
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../providers/AuthProvider';
import { useSocket } from '../providers/SocketProvider';
import { ROLE_LABEL } from '../lib/labels';
import type { Role } from '../types/api';
import { Avatar } from './ui/Avatar';
import { Popover } from './ui/Popover';
import { NotificationBell } from './NotificationBell';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles?: Role[];
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: '◫', end: true },
  { to: '/projects', label: 'Projects', icon: '▣' },
  { to: '/tasks', label: 'Tasks', icon: '☰' },
  { to: '/activity', label: 'Activity', icon: '⟳' },
  { to: '/clients', label: 'Clients', icon: '◆', roles: ['ADMIN', 'PROJECT_MANAGER'] },
  { to: '/team', label: 'Team', icon: '✦', roles: ['ADMIN'] },
];

export const AppShell = (): React.JSX.Element => {
  const { user, logout } = useAuth();
  const { connected } = useSocket();
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();

  if (!user) return <></>;

  const items = NAV.filter((item) => !item.roles || item.roles.includes(user.role));

  return (
    <div className="shell">
      <div className="shell-brand">
        <span className="brand-mark" aria-hidden="true">
          V
        </span>
        <span className="brand-name">Velozity</span>
      </div>

      <header className="shell-header">
        <div className="row gap-3">
          <span className={`conn ${connected ? 'conn-live' : 'conn-down'}`} title={
            connected
              ? 'Connected over WebSocket — updates arrive without refreshing.'
              : 'Reconnecting to the live channel.'
          }>
            <span className="conn-dot" />
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>

        <div className="row gap-3">
          <NotificationBell />

          <Popover
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            trigger={
              <button
                type="button"
                className="user-chip"
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
              >
                <Avatar name={user.name} color={user.avatarColor} />
                <span className="col" style={{ lineHeight: 1.2, alignItems: 'flex-start' }}>
                  <span className="small strong">{user.name}</span>
                  <span className="tiny dim">{ROLE_LABEL[user.role]}</span>
                </span>
              </button>
            }
          >
            <div className="popover-head">
              <div className="strong">{user.name}</div>
              <div className="small muted truncate">{user.email}</div>
              {user.jobTitle ? <div className="tiny dim">{user.jobTitle}</div> : null}
            </div>
            <button
              type="button"
              className="popover-item"
              onClick={() => {
                setMenuOpen(false);
                navigate('/account');
              }}
            >
              Change password
            </button>
            <button
              type="button"
              className="popover-item"
              onClick={() => {
                setMenuOpen(false);
                void logout();
              }}
            >
              Sign out
            </button>
          </Popover>
        </div>
      </header>

      <nav className="shell-sidebar" aria-label="Main">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end ?? false}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
          >
            <span className="nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
};
