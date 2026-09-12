import { useEffect, useState } from 'react';

/**
 * A clock that re-renders its consumer on an interval.
 *
 * Relative timestamps ("2 mins ago") are the one thing on the page that goes
 * stale without any data changing. One shared 30-second tick keeps every
 * timestamp honest; a timer per feed row would not.
 */
export const useNow = (intervalMs = 30_000): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now;
};
