/**
 * WebSocket presence registry.
 *
 * Backs the admin dashboard's "active users online right now" tile. Presence is
 * *connection* state, not domain state, so it deliberately lives in memory
 * rather than in Postgres — writing a row on every tab open/close would put
 * pointless write load on the database for a number that is meaningless the
 * moment the process restarts.
 *
 * One user can hold several sockets (multiple tabs, phone + laptop), so the
 * registry counts *distinct users* and only reports a change when someone's
 * first socket arrives or last socket leaves. That prevents the tile from
 * flickering when a tab reconnects.
 *
 * Known limitation (documented in README.md): this is per-process. Running more
 * than one API instance needs `@socket.io/redis-adapter` so presence and fanout
 * are shared; the rest of the real-time design is already adapter-agnostic
 * because it only ever uses rooms.
 */
import type { Role } from '../db/client.js';
import type { PresenceDto } from './types.js';

interface PresentUser {
  id: string;
  name: string;
  role: Role;
  avatarColor: string;
  socketIds: Set<string>;
  since: Date;
}

const online = new Map<string, PresentUser>();

export interface PresenceIdentity {
  userId: string;
  name: string;
  role: Role;
  avatarColor: string;
}

/**
 * @returns `true` when this connection changed the *set* of online users (i.e.
 *          the user was not already online), meaning the tile needs an update.
 */
export const trackConnection = (identity: PresenceIdentity, socketId: string): boolean => {
  const existing = online.get(identity.userId);
  if (existing) {
    existing.socketIds.add(socketId);
    return false;
  }
  online.set(identity.userId, {
    id: identity.userId,
    name: identity.name,
    role: identity.role,
    avatarColor: identity.avatarColor,
    socketIds: new Set([socketId]),
    since: new Date(),
  });
  return true;
};

/** @returns `true` when that was the user's last socket, so they are now offline. */
export const trackDisconnection = (userId: string, socketId: string): boolean => {
  const existing = online.get(userId);
  if (!existing) return false;

  existing.socketIds.delete(socketId);
  if (existing.socketIds.size === 0) {
    online.delete(userId);
    return true;
  }
  return false;
};

export const presenceSnapshot = (): PresenceDto => ({
  onlineCount: online.size,
  users: [...online.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ id, name, role, avatarColor }) => ({ id, name, role, avatarColor })),
});

export const isUserOnline = (userId: string): boolean => online.has(userId);

/** Test hook — the registry is module-level state. */
export const resetPresence = (): void => {
  online.clear();
};
