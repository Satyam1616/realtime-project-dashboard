/**
 * Session state for the whole app.
 *
 * The access token is deliberately *not* in this context — it lives inside
 * `lib/api.ts` where nothing can render it into the DOM or hand it to a child
 * component by accident. This provider owns only the user record and the
 * three-state lifecycle that the router switches on.
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
import { authApi, bootstrapSession, onSessionLost, refreshSession, type RegisterInput } from '../lib/api';
import type { CurrentUser, Role } from '../types/api';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  user: CurrentUser | null;
  status: AuthStatus;
  /** Set when a session ended on its own, so the login page can explain why. */
  endedReason: 'expired' | 'revoked' | null;
  login: (email: string, password: string) => Promise<CurrentUser>;
  register: (input: RegisterInput) => Promise<CurrentUser>;
  logout: () => Promise<void>;
  is: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Refresh this far before the access token expires. Early enough to absorb a
 * slow network, late enough that a 15-minute token is not refreshed every
 * minute.
 */
const REFRESH_LEAD_MS = 60_000;

export const AuthProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [endedReason, setEndedReason] = useState<'expired' | 'revoked' | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  /**
   * Keep the in-memory access token fresh ahead of expiry.
   *
   * Without this the token simply expires and the next request pays a 401 and
   * a retry — correct, but it also means the *socket* would reconnect with a
   * dead token after a network blip. Refreshing on a timer keeps both paths
   * holding something valid.
   */
  const scheduleRefresh = useCallback(
    (expiresInSeconds: number) => {
      clearTimer();
      const delay = Math.max(15_000, expiresInSeconds * 1000 - REFRESH_LEAD_MS);
      refreshTimer.current = window.setTimeout(() => {
        void (async () => {
          const token = await refreshSession();
          if (token) {
            scheduleRefresh(expiresInSeconds);
          } else {
            // The cookie is gone or revoked. `onSessionLost` handles the UI;
            // stop the timer so we do not hammer a dead session.
            clearTimer();
          }
        })();
      }, delay);
    },
    [clearTimer],
  );

  /* --- boot: exchange the HttpOnly cookie for a session ------------- */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const restored = await bootstrapSession();
      if (cancelled) return;

      if (restored) {
        setUser(restored);
        setStatus('authenticated');
        // The refresh response carried an `expiresIn` we did not keep; 15
        // minutes matches the server default and the timer self-corrects from
        // the next real login.
        scheduleRefresh(15 * 60);
      } else {
        setStatus('anonymous');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scheduleRefresh]);

  /* --- the session ending without the user asking ------------------- */
  useEffect(
    () =>
      onSessionLost((reason) => {
        clearTimer();
        setUser(null);
        setStatus('anonymous');
        setEndedReason(reason);
      }),
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const login = useCallback(
    async (email: string, password: string): Promise<CurrentUser> => {
      const result = await authApi.login(email, password);
      setUser(result.user);
      setStatus('authenticated');
      setEndedReason(null);
      scheduleRefresh(result.expiresIn);
      return result.user;
    },
    [scheduleRefresh],
  );

  const register = useCallback(
    async (input: RegisterInput): Promise<CurrentUser> => {
      const result = await authApi.register(input);
      setUser(result.user);
      setStatus('authenticated');
      setEndedReason(null);
      scheduleRefresh(result.expiresIn);
      return result.user;
    },
    [scheduleRefresh],
  );

  const logout = useCallback(async (): Promise<void> => {
    clearTimer();
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      setStatus('anonymous');
      setEndedReason(null);
    }
  }, [clearTimer]);

  const is = useCallback((...roles: Role[]): boolean => (user ? roles.includes(user.role) : false), [user]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, endedReason, login, register, logout, is }),
    [user, status, endedReason, login, register, logout, is],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>.');
  return context;
};

/**
 * The signed-in user, for components that only render behind a route guard.
 *
 * Saves every dashboard from a `user &&` dance that the router has already
 * guaranteed. Throwing here surfaces a routing mistake immediately instead of
 * rendering an empty page.
 */
export const useCurrentUser = (): CurrentUser => {
  const { user } = useAuth();
  if (!user) throw new Error('useCurrentUser used outside an authenticated route.');
  return user;
};
