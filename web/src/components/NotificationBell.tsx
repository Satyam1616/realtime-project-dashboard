/**
 * Notification bell: unread badge + dropdown.
 *
 * The badge number comes from `notification:count`, pushed by the server. It
 * is never computed from the loaded list — the list is one page of twenty and
 * the count is everything — and it is never polled.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../providers/NotificationProvider';
import { relativeTime, absoluteDateTime } from '../lib/time';
import { useNow } from '../hooks/useNow';
import { Popover } from './ui/Popover';
import { EmptyState, Spinner } from './ui/Feedback';

export const NotificationBell = (): React.JSX.Element => {
  const { items, unread, loading, refresh, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const now = useNow();

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    // Re-read on open: the socket keeps the count live, but a notification
    // that arrived in another tab is not in this tab's list.
    if (next) void refresh();
  };

  const openTarget = (id: string, taskId: string | null, projectId: string | null): void => {
    void markRead(id);
    setOpen(false);
    if (taskId) navigate(`/tasks/${taskId}`);
    else if (projectId) navigate(`/projects/${projectId}`);
  };

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      className="tray"
      trigger={
        <button
          type="button"
          className="bell"
          onClick={toggle}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          aria-expanded={open}
        >
          <span aria-hidden="true">🔔</span>
          {unread > 0 ? (
            // `key` on the count so React remounts the node and the pop
            // animation replays whenever the number actually changes.
            <span className="bell-badge" key={unread}>
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </button>
      }
    >
      <div className="popover-head row-between">
        <strong>Notifications</strong>
        <div className="row gap-2">
          {loading ? <Spinner /> : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void markAllRead()}
            disabled={unread === 0}
          >
            Mark all read
          </button>
        </div>
      </div>

      <div className="tray-list">
        {items.length === 0 ? (
          <EmptyState title="All clear" hint="Assignments and review requests land here." />
        ) : (
          items.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`tray-item${item.readAt ? '' : ' unread'}`}
              onClick={() => openTarget(item.id, item.taskId, item.projectId)}
            >
              <span className={`tray-dot${item.readAt ? ' read' : ''}`} aria-hidden="true" />
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="strong small" style={{ display: 'block' }}>
                  {item.title}
                </span>
                <span className="muted small clamp-2" style={{ display: 'block' }}>
                  {item.body}
                </span>
                <span className="dim tiny" title={absoluteDateTime(item.createdAt)}>
                  {relativeTime(item.createdAt, now)}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </Popover>
  );
};
