/**
 * The HTTP client.
 *
 * Two decisions drive this file:
 *
 * 1. **The access token lives in a module-scoped variable, never in
 *    `localStorage`.** A token in web storage is readable by any script that
 *    gets injected into the page; a token in a closure is not. The cost is that
 *    a page refresh loses it — which is exactly what `bootstrap()` is for: the
 *    `HttpOnly` refresh cookie the browser still holds is exchanged for a fresh
 *    access token on boot. The refresh token itself is never visible to this
 *    code at all.
 *
 * 2. **A 401 triggers one refresh, shared by every caller.** Six widgets
 *    mounting at once must not fire six refreshes: the server rotates the token
 *    on each use and treats a re-used token as theft, so a naive
 *    refresh-per-request would revoke the whole family and log the user out.
 *    `refreshPromise` is the single-flight latch.
 */
import type { ApiErrorBody, CurrentUser, LoginResponse } from '../types/api';

/**
 * Blank in development: Vite proxies `/api` to the backend so the browser stays
 * same-origin and the refresh cookie needs no `SameSite=None`.
 */
const BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export const apiUrl = (path: string): string => `${BASE_URL}/api${path}`;
/** Socket.IO connects to the origin itself, not the `/api` prefix. */
export const socketOrigin = (): string => BASE_URL || window.location.origin;

/** A failed response, carrying the server's structured error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Array<{ path: string; message: string }>;

  constructor(status: number, code: string, message: string, details?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? [];
  }

  /** Field-level messages, for rendering next to inputs. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const detail of this.details) {
      if (!(detail.path in out)) out[detail.path] = detail.message;
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Access-token store
 * ------------------------------------------------------------------ */

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

/** Notified when the session ends for a reason the user did not ask for. */
type SessionListener = (reason: 'expired' | 'revoked') => void;
const sessionListeners = new Set<SessionListener>();

export const onSessionLost = (listener: SessionListener): (() => void) => {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
};

const announceSessionLost = (reason: 'expired' | 'revoked'): void => {
  accessToken = null;
  for (const listener of sessionListeners) listener(reason);
};

export const getAccessToken = (): string | null => accessToken;
export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};

/* ------------------------------------------------------------------ *
 * Core request
 * ------------------------------------------------------------------ */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Internal: suppresses the refresh-and-retry dance to avoid recursion. */
  skipAuthRetry?: boolean;
}

const parseError = async (response: Response): Promise<ApiError> => {
  let code = 'HTTP_ERROR';
  let message = response.statusText || 'Request failed.';
  let details: Array<{ path: string; message: string }> | undefined;

  try {
    const body = (await response.json()) as ApiErrorBody;
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    // A non-JSON error body (a proxy 502, say) keeps the status-text default.
  }

  return new ApiError(response.status, code, message, details);
};

const send = async (path: string, options: RequestOptions): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let payload: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  return fetch(apiUrl(path), {
    method: options.method ?? 'GET',
    headers,
    ...(payload === undefined ? {} : { body: payload }),
    ...(options.signal ? { signal: options.signal } : {}),
    // Sends the HttpOnly refresh cookie. Required even same-origin for the
    // cross-origin production deployment to behave identically.
    credentials: 'include',
  });
};

/**
 * Exchange the refresh cookie for a new access token.
 *
 * Single-flight: concurrent callers await the same promise, so the rotating
 * refresh token is spent exactly once.
 */
export const refreshSession = async (): Promise<string | null> => {
  refreshPromise ??= (async () => {
    try {
      const response = await fetch(apiUrl('/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) return null;
      const data = (await response.json()) as LoginResponse;
      accessToken = data.accessToken;
      return data.accessToken;
    } catch {
      return null;
    } finally {
      // Cleared in a microtask so callers that arrived during the await still
      // join *this* flight rather than starting a second one.
      queueMicrotask(() => {
        refreshPromise = null;
      });
    }
  })();

  return refreshPromise;
};

const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  let response = await send(path, options);

  if (response.status === 401 && !options.skipAuthRetry) {
    const token = await refreshSession();
    if (!token) {
      announceSessionLost('expired');
      throw await parseError(response);
    }
    response = await send(path, { ...options, skipAuthRetry: true });
  }

  if (!response.ok) {
    const error = await parseError(response);
    if (error.status === 401) announceSessionLost('expired');
    throw error;
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
};

/* ------------------------------------------------------------------ *
 * Query-string helper
 * ------------------------------------------------------------------ */

/**
 * Build a query string, dropping empty values so a cleared filter disappears
 * from the URL instead of lingering as `?status=`.
 *
 * Arrays become the CSV the API expects (`status=TODO,IN_PROGRESS`) rather than
 * repeated keys, matching `tasks.schemas.ts`.
 */
export const toQuery = (params: Record<string, string | number | boolean | string[] | null | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
};

/* ------------------------------------------------------------------ *
 * Verb helpers
 * ------------------------------------------------------------------ */

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> =>
    request<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
    request<T>(path, { method: 'POST', ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}) }),
  patch: <T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> =>
    request<T>(path, { method: 'PATCH', body, ...(signal ? { signal } : {}) }),
  delete: <T>(path: string, signal?: AbortSignal): Promise<T> =>
    request<T>(path, { method: 'DELETE', ...(signal ? { signal } : {}) }),
};

/* ------------------------------------------------------------------ *
 * Auth calls
 * ------------------------------------------------------------------ */

export const authApi = {
  login: async (email: string, password: string): Promise<LoginResponse> => {
    const data = await request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      // A 401 here means "wrong password", not "expired session". Retrying it
      // through the refresh path would produce a confusing second failure.
      skipAuthRetry: true,
    });
    accessToken = data.accessToken;
    return data;
  },

  logout: async (): Promise<void> => {
    try {
      await request<void>('/auth/logout', { method: 'POST', skipAuthRetry: true });
    } finally {
      accessToken = null;
    }
  },

  me: (): Promise<{ user: CurrentUser }> => api.get<{ user: CurrentUser }>('/auth/me'),

  changePassword: (currentPassword: string, newPassword: string): Promise<void> =>
    api.post<void>('/auth/change-password', { currentPassword, newPassword }),
};

/**
 * Restore a session on page load.
 *
 * Returns the signed-in user, or `null` when the browser holds no usable
 * refresh cookie — which is the ordinary "not logged in" case, not an error.
 */
export const bootstrapSession = async (): Promise<CurrentUser | null> => {
  const token = await refreshSession();
  if (!token) return null;
  try {
    const { user } = await authApi.me();
    return user;
  } catch {
    accessToken = null;
    return null;
  }
};

/** Called by the socket layer when the server closes a session server-side. */
export const declareRevoked = (): void => announceSessionLost('revoked');
