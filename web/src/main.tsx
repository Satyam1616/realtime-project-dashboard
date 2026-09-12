/**
 * Entry point.
 *
 * `StrictMode` stays on deliberately. Its double-invoked effects are the reason
 * the socket layer re-sends its room memberships on every `connect` and the
 * reason session bootstrap is single-flighted in `lib/api.ts` — a mount /
 * unmount / mount cycle in development surfaces exactly the bugs a real
 * reconnect would, and finding them here is cheaper than finding them live.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
