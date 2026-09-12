/**
 * Notification state.
 *
 * The unread badge is authoritative from the server and arrives over the
 * socket — `notification:count` on connect and after every change. Nothing
 * here polls, and the local count is never incremented optimistically on a new
 * notification: the server sends the count alongside it, and trusting one
 * source keeps two tabs from disagreeing.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../lib/api';
import type { NotificationDto, NotificationListDto } from '../types/api';
import { useAuth } from './AuthProvider';
import { useRealtimeEvent } from './SocketProvider';

interface NotificationContextValue {
  items: NotificationDto[];
  unread: number;
  loading: boolean;
  /** Fetch the first page. Safe to call repeatedly; used when opening the tray. */
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue>({
  items: [],
  unread: 0,
  loading: false,
  refresh: async () => {},
  markRead: async () => {},
  markAllRead: async () => {},
});

const PAGE_SIZE = 20;

export const NotificationProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const { status } = useAuth();
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api.get<NotificationListDto>(`/notifications?limit=${PAGE_SIZE}`);
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      // A failed tray load is not worth an error banner; the badge keeps
      // whatever the socket last pushed.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'authenticated') {
      void refresh();
    } else {
      setItems([]);
      setUnread(0);
    }
  }, [status, refresh]);

  /** The count the server calculated. Pushed on connect and on every change. */
  useRealtimeEvent(
    'notification:count',
    useCallback((payload: { unread: number }) => setUnread(payload.unread), []),
  );

  useRealtimeEvent(
    'notification:new',
    useCallback((notification: NotificationDto) => {
      setItems((current) =>
        // Guard against a double delivery across a reconnect replay.
        current.some((item) => item.id === notification.id)
          ? current
          : [notification, ...current].slice(0, PAGE_SIZE),
      );
    }, []),
  );

  const markRead = useCallback(async (id: string): Promise<void> => {
    const target = items.find((item) => item.id === id);
    if (!target || target.readAt) return;

    // Optimistic on the row (instant feedback), authoritative on the count
    // (the server's reply wins, and the socket confirms it to other tabs).
    const stamp = new Date().toISOString();
    setItems((current) => current.map((item) => (item.id === id ? { ...item, readAt: stamp } : item)));

    try {
      const result = await api.post<{ unread: number }>(`/notifications/${id}/read`);
      setUnread(result.unread);
    } catch {
      setItems((current) => current.map((item) => (item.id === id ? { ...item, readAt: null } : item)));
    }
  }, [items]);

  const markAllRead = useCallback(async (): Promise<void> => {
    const snapshot = items;
    const stamp = new Date().toISOString();
    setItems((current) => current.map((item) => (item.readAt ? item : { ...item, readAt: stamp })));

    try {
      const result = await api.post<{ unread: number }>('/notifications/read-all');
      setUnread(result.unread);
    } catch {
      setItems(snapshot);
    }
  }, [items]);

  const value = useMemo<NotificationContextValue>(
    () => ({ items, unread, loading, refresh, markRead, markAllRead }),
    [items, unread, loading, refresh, markRead, markAllRead],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
};

export const useNotifications = (): NotificationContextValue => useContext(NotificationContext);
