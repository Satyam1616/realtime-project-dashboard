/**
 * Deterministic avatar tint.
 *
 * Lives in `lib/` rather than beside either caller because both the admin
 * "create user" path and self-service registration need it, and importing one
 * service from the other would close a cycle (`users.service` already imports
 * `revokeAllSessions` from `auth.service`).
 *
 * Deterministic on purpose: the same address always produces the same colour, so
 * an avatar does not change identity when a row is re-created by the seed.
 */

/** A palette that stays legible against both the light and dark surfaces. */
const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

export const pickAvatarColor = (seed: string): string => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
};
