/**
 * The WebSocket connection.
 *
 * One socket for the whole app. Every component that wants live data attaches
 * a listener through `useRealtimeEvent` instead of opening its own connection —
 * a second socket would double presence counts and duplicate every event.
 *
 * Delivery is already role-filtered by the server: the client never decides
 * what it is allowed to see, it only decides what to do with what arrives.
 * `fanout.ts` is the authority; this file is a renderer.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { declareRevoked, getAccessToken, refreshSession, socketOrigin } from '../lib/api';
import type { ClientToServerEvents, ServerToClientEvents } from '../types/realtime';
import { useAuth } from './AuthProvider';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface SocketContextValue {
  socket: AppSocket | null;
  connected: boolean;
  /** Join a project room; resolves with the server's authorisation verdict. */
  subscribeProject: (projectId: string) => Promise<boolean>;
  unsubscribeProject: (projectId: string) => void;
  /** Persist the activity high-water mark used by `/activity/catchup`. */
  markSeen: (seq: number) => void;
}

const SocketContext = createContext<SocketContextValue>({
  socket: null,
  connected: false,
  subscribeProject: async () => false,
  unsubscribeProject: () => {},
  markSeen: () => {},
});

export const SocketProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const { status, user } = useAuth();
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [connected, setConnected] = useState(false);

  /**
   * Rooms this client believes it is in. Socket.IO does not restore room
   * membership across a reconnect — the server-side socket is a new object —
   * so they are re-sent on every `connect`.
   */
  const rooms = useRef(new Set<string>());

  useEffect(() => {
    if (status !== 'authenticated' || !user) {
      setSocket(null);
      setConnected(false);
      rooms.current.clear();
      return;
    }

    const instance: AppSocket = io(socketOrigin(), {
      // WebSocket only. The brief rules out long-polling and the server pins
      // the same list, so a failed upgrade is a visible error rather than a
      // silent fallback to HTTP polling.
      transports: ['websocket'],
      withCredentials: true,
      // A function, not a value: it is re-evaluated on every reconnect
      // attempt, so a token refreshed while offline is picked up automatically.
      auth: (cb) => cb({ token: getAccessToken() }),
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });

    instance.on('connect', () => {
      setConnected(true);
      for (const projectId of rooms.current) {
        instance.emit('project:subscribe', { projectId });
      }
    });

    instance.on('disconnect', () => setConnected(false));

    /**
     * A rejected handshake is almost always an expired access token — the page
     * has been open longer than the token's lifetime. Refresh once and let the
     * built-in backoff retry; if the refresh itself fails, the session is
     * genuinely over and `lib/api` has already told `AuthProvider`.
     */
    instance.on('connect_error', (error) => {
      setConnected(false);
      if (error.message === 'UNAUTHENTICATED') {
        void refreshSession();
      }
    });

    // The server closing a session deliberately (deactivated account, password
    // change elsewhere). Not a transport problem — stop reconnecting.
    instance.on('session:revoked', () => {
      instance.disconnect();
      declareRevoked();
    });

    setSocket(instance);

    return () => {
      instance.removeAllListeners();
      instance.disconnect();
      setSocket(null);
      setConnected(false);
    };
    // Re-created when the *identity* changes, not on every render of the user
    // object: a refreshed profile must not tear down a healthy connection.
  }, [status, user?.id]);

  const subscribeProject = useCallback(
    (projectId: string): Promise<boolean> => {
      rooms.current.add(projectId);
      if (!socket?.connected) {
        // Queued: the `connect` handler replays `rooms` once the socket is up.
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        socket.emit('project:subscribe', { projectId }, (result) => resolve(Boolean(result?.ok)));
      });
    },
    [socket],
  );

  const unsubscribeProject = useCallback(
    (projectId: string): void => {
      rooms.current.delete(projectId);
      socket?.emit('project:unsubscribe', { projectId });
    },
    [socket],
  );

  const markSeen = useCallback(
    (seq: number): void => {
      if (Number.isInteger(seq) && seq > 0) socket?.emit('activity:seen', { seq });
    },
    [socket],
  );

  const value = useMemo<SocketContextValue>(
    () => ({ socket, connected, subscribeProject, unsubscribeProject, markSeen }),
    [socket, connected, subscribeProject, unsubscribeProject, markSeen],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

export const useSocket = (): SocketContextValue => useContext(SocketContext);

/**
 * Attach a listener for the lifetime of a component.
 *
 * The handler is held in a ref so a caller may pass an inline arrow function
 * without re-subscribing on every render — the usual cause of duplicated
 * feed entries.
 */
export const useRealtimeEvent = <E extends keyof ServerToClientEvents>(
  event: E,
  handler: ServerToClientEvents[E],
): void => {
  const { socket } = useSocket();
  const ref = useRef(handler);

  useEffect(() => {
    ref.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!socket) return;

    const listener = (...args: unknown[]): void => {
      (ref.current as unknown as (...received: unknown[]) => void)(...args);
    };

    socket.on(event, listener as never);
    return () => {
      socket.off(event, listener as never);
    };
  }, [socket, event]);
};

/**
 * Declare "I am looking at this project" for as long as the component is
 * mounted. Membership of the room is what makes `task:changed` arrive; the
 * server still re-checks permission per recipient before sending.
 */
export const useProjectRoom = (projectId: string | null | undefined): void => {
  const { subscribeProject, unsubscribeProject, connected } = useSocket();

  useEffect(() => {
    if (!projectId) return;
    void subscribeProject(projectId);
    return () => unsubscribeProject(projectId);
    // `connected` is a dependency so a reconnect re-runs the subscribe for the
    // project currently on screen even if the replay in `connect` raced it.
  }, [projectId, connected, subscribeProject, unsubscribeProject]);
};
