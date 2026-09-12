/**
 * A very small data-fetching hook.
 *
 * Deliberately not React Query. The app has ten or so read endpoints, none of
 * which need cache sharing across routes, and the live layer already handles
 * invalidation by pushing the changed entity — a cache library on top of a
 * WebSocket mostly means reconciling two sources of truth. What is needed is
 * loading/error/refetch with a clean abort, which is this file.
 *
 * See "Known limitations" in README.md: a larger app would want real caching.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';

export interface QueryResult<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** Re-run the request. Used by realtime handlers and by retry buttons. */
  refetch: () => void;
  /** Patch the local copy, for optimistic updates and socket-driven merges. */
  setData: (updater: (current: T | null) => T | null) => void;
}

/**
 * @param path  Request path including query string; a change re-fetches.
 * @param enabled  Skip the request entirely (e.g. a route param not ready yet).
 */
export const useApiQuery = <T>(path: string | null, enabled = true): QueryResult<T> => {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path) && enabled);
  const [nonce, setNonce] = useState(0);

  /**
   * Guards against a slow first response overwriting a fast second one. An
   * abort handles the common case, but a request that already resolved cannot
   * be aborted — the generation check catches that.
   */
  const generation = useRef(0);

  useEffect(() => {
    if (!path || !enabled) {
      setLoading(false);
      return;
    }

    const current = ++generation.current;
    const controller = new AbortController();
    setLoading(true);

    void (async () => {
      try {
        const result = await api.get<T>(path, controller.signal);
        if (generation.current !== current) return;
        setDataState(result);
        setError(null);
      } catch (caught) {
        if (generation.current !== current) return;
        if (controller.signal.aborted) return;
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.'),
        );
      } finally {
        if (generation.current === current) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [path, enabled, nonce]);

  const refetch = useCallback(() => setNonce((value) => value + 1), []);

  const setData = useCallback((updater: (current: T | null) => T | null) => {
    setDataState((current) => updater(current));
  }, []);

  return { data, error, loading, refetch, setData };
};
