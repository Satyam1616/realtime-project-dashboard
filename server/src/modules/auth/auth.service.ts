/**
 * Authentication service: login, refresh-token rotation, logout.
 *
 * The refresh flow implements **rotation with reuse detection**, which is the
 * part worth reading:
 *
 *   - Every refresh consumes the presented token and issues a new one in the
 *     same `familyId`. A refresh token is therefore single-use.
 *   - Consumed tokens are kept (marked `revokedAt`) rather than deleted,
 *     because their later reappearance is *evidence*. If an already-rotated
 *     token is presented, the only explanations are a stolen cookie being
 *     replayed or a client bug — so the entire family is revoked, which logs the
 *     real user out and forces a fresh login rather than letting an attacker
 *     ride the session indefinitely.
 *   - Tokens are stored as SHA-256 digests, so a database dump yields no usable
 *     sessions.
 */
import { prisma, Role, type User } from '../../db/client.js';
import { burnPasswordComparison, hashPassword, verifyPassword } from '../../lib/password.js';
import { hashToken, signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/tokens.js';
import { ErrorCode, invalidCredentials, unauthenticated } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getIO } from '../../realtime/socket.server.js';
import { revokeUserSockets } from '../../realtime/fanout.js';

export interface SessionMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarColor: string;
  jobTitle: string | null;
}

export const toPublicUser = (
  user: Pick<User, 'id' | 'email' | 'name' | 'role' | 'avatarColor' | 'jobTitle'>,
): PublicUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  avatarColor: user.avatarColor,
  jobTitle: user.jobTitle,
});

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  /** Returned so the route can put it in the HttpOnly cookie. Never in a body. */
  refreshToken: string;
  expiresIn: string;
}

const issueSession = async (
  user: Pick<User, 'id' | 'email' | 'name' | 'role' | 'avatarColor' | 'jobTitle'>,
  meta: SessionMeta,
  familyId?: string,
): Promise<AuthResult> => {
  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
  });

  const refresh = signRefreshToken(user.id, familyId);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refresh.token),
      familyId: refresh.familyId,
      expiresAt: refresh.expiresAt,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
    },
  });

  return {
    user: toPublicUser(user),
    accessToken,
    refreshToken: refresh.token,
    expiresIn: '15m',
  };
};

/* ------------------------------------------------------------------ *
 * Login
 * ------------------------------------------------------------------ */

export const login = async (email: string, password: string, meta: SessionMeta): Promise<AuthResult> => {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Spend the same time as a real comparison so response timing does not
    // reveal whether the address is registered.
    await burnPasswordComparison(password);
    throw invalidCredentials();
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw invalidCredentials();
  }

  if (!user.isActive) {
    // Distinct from bad credentials: the user typed the right password, so
    // telling them the account is disabled is useful and reveals nothing an
    // authenticated-but-disabled user does not already know.
    throw unauthenticated('This account has been deactivated. Contact an administrator.', ErrorCode.TOKEN_INVALID);
  }

  return issueSession(user, meta);
};

/* ------------------------------------------------------------------ *
 * Refresh (rotation + reuse detection)
 * ------------------------------------------------------------------ */

const revokeFamily = async (familyId: string, reason: string): Promise<void> => {
  const { count } = await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  logger.warn({ familyId, revoked: count, reason }, 'refresh token family revoked');
};

export const refresh = async (rawToken: string, meta: SessionMeta): Promise<AuthResult> => {
  const claims = verifyRefreshToken(rawToken);
  const tokenHash = hashToken(rawToken);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: { id: true, email: true, name: true, role: true, avatarColor: true, jobTitle: true, isActive: true },
      },
    },
  });

  // Signature valid but no matching row: the row was pruned after expiry, or
  // the token was minted with a leaked secret. Revoke the family defensively.
  if (!stored) {
    await revokeFamily(claims.fid, 'presented token not on record');
    throw unauthenticated('Session is no longer valid. Please sign in again.', ErrorCode.TOKEN_REUSED);
  }

  // --- Reuse detection -------------------------------------------------
  if (stored.revokedAt) {
    await revokeFamily(stored.familyId, 'already-rotated token replayed');
    // Kill live sockets too: a stolen session should lose its real-time feed
    // immediately, not when its access token happens to expire.
    const io = getIO();
    if (io) await revokeUserSockets(io, stored.userId, 'Session revoked — please sign in again.');
    throw unauthenticated(
      'This session was already refreshed and has been revoked for security. Please sign in again.',
      ErrorCode.TOKEN_REUSED,
    );
  }

  if (stored.expiresAt.getTime() <= Date.now()) {
    throw unauthenticated('Session expired. Please sign in again.', ErrorCode.TOKEN_EXPIRED);
  }

  if (!stored.user.isActive) {
    await revokeFamily(stored.familyId, 'account deactivated');
    throw unauthenticated('This account has been deactivated.', ErrorCode.TOKEN_INVALID);
  }

  // --- Rotate ----------------------------------------------------------
  const next = signRefreshToken(stored.userId, stored.familyId);

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedByJti: next.jti },
    }),
    prisma.refreshToken.create({
      data: {
        userId: stored.userId,
        tokenHash: hashToken(next.token),
        familyId: stored.familyId,
        expiresAt: next.expiresAt,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
        ip: meta.ip?.slice(0, 64) ?? null,
      },
    }),
  ]);

  return {
    user: toPublicUser(stored.user),
    accessToken: signAccessToken({
      sub: stored.user.id,
      email: stored.user.email,
      role: stored.user.role,
      name: stored.user.name,
    }),
    refreshToken: next.token,
    expiresIn: '15m',
  };
};

/* ------------------------------------------------------------------ *
 * Logout
 * ------------------------------------------------------------------ */

/**
 * Revokes the presented token's whole family, so signing out on one device
 * ends that device's session chain rather than leaving a rotated descendant
 * usable. Intentionally forgiving: an unparseable or unknown cookie still
 * results in a successful logout, because the caller's goal — "end my
 * session" — is achieved either way.
 */
export const logout = async (rawToken: string | null): Promise<void> => {
  if (!rawToken) return;

  try {
    const claims = verifyRefreshToken(rawToken);
    await revokeFamily(claims.fid, 'user signed out');
  } catch {
    // Fall back to revoking by hash if the JWT itself is unreadable.
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
};

/** Used when an admin deactivates an account or a password changes. */
export const revokeAllSessions = async (userId: string, reason: string): Promise<void> => {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const io = getIO();
  if (io) await revokeUserSockets(io, userId, reason);
  logger.info({ userId, reason }, 'all sessions revoked');
};

/* ------------------------------------------------------------------ *
 * Password change
 * ------------------------------------------------------------------ */

export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) throw unauthenticated();

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw invalidCredentials();
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  // A password change must invalidate sessions that were established with the
  // old one — that is the point of changing it.
  await revokeAllSessions(userId, 'Password changed — please sign in again.');
};

/**
 * Housekeeping for expired/revoked token rows.
 *
 * Revoked rows are kept for a grace period rather than deleted immediately, so
 * reuse detection still fires for a replay that arrives shortly after rotation.
 */
export const pruneRefreshTokens = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { count } = await prisma.refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return count;
};
