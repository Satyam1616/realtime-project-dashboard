/**
 * JWT issuing and verification.
 *
 * Two token types, deliberately different in lifetime, storage and secret:
 *
 *   Access token  — 15 min, signed with JWT_ACCESS_SECRET, sent as
 *                   `Authorization: Bearer ...`, held only in browser memory.
 *   Refresh token — 7 days, signed with JWT_REFRESH_SECRET, delivered in an
 *                   HttpOnly cookie, and additionally recorded in the database
 *                   (hashed) so it can be rotated and revoked server-side.
 *
 * Using two different secrets means an access token can never be replayed at the
 * refresh endpoint, and vice versa, even though both are JWTs.
 *
 * The refresh token carries a `familyId`: every rotation issues a new token in
 * the same family. If a token that has already been rotated is presented again,
 * the whole family is revoked — that is the signature of a stolen cookie being
 * replayed, and it logs the real user out rather than letting the attacker ride
 * along. See `auth.service.ts` for the rotation logic.
 */
import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ErrorCode, unauthenticated } from './errors.js';
import type { Role } from '../db/client.js';

const ISSUER = 'velozity-api';
const AUDIENCE = 'velozity-web';

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: Role;
  name: string;
  /** Discriminator so a refresh token can never satisfy an access-token check. */
  typ: 'access';
}

export interface RefreshTokenClaims {
  sub: string;
  /** Rotation family, used for stolen-token reuse detection. */
  fid: string;
  /** Unique id for this individual token, hashed into the `RefreshToken` row. */
  jti: string;
  typ: 'refresh';
}

export const signAccessToken = (claims: Omit<AccessTokenClaims, 'typ'>): string =>
  jwt.sign({ ...claims, typ: 'access' } satisfies AccessTokenClaims, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
    issuer: ISSUER,
    audience: AUDIENCE,
  } as SignOptions);

export interface IssuedRefreshToken {
  token: string;
  jti: string;
  familyId: string;
  expiresAt: Date;
}

export const signRefreshToken = (userId: string, familyId: string = crypto.randomUUID()): IssuedRefreshToken => {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const token = jwt.sign({ sub: userId, fid: familyId, jti, typ: 'refresh' } satisfies RefreshTokenClaims, env.JWT_REFRESH_SECRET, {
    expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d`,
    issuer: ISSUER,
    audience: AUDIENCE,
  } as SignOptions);

  return { token, jti, familyId, expiresAt };
};

const verify = <T>(token: string, secret: string, expectedType: 'access' | 'refresh'): T => {
  try {
    const payload = jwt.verify(token, secret, { issuer: ISSUER, audience: AUDIENCE }) as T & { typ?: string };
    if (payload.typ !== expectedType) {
      throw unauthenticated('Token is not valid for this operation.', ErrorCode.TOKEN_INVALID);
    }
    return payload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw unauthenticated('Session expired.', ErrorCode.TOKEN_EXPIRED);
    }
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.NotBeforeError) {
      throw unauthenticated('Invalid token.', ErrorCode.TOKEN_INVALID);
    }
    throw error;
  }
};

export const verifyAccessToken = (token: string): AccessTokenClaims =>
  verify<AccessTokenClaims>(token, env.JWT_ACCESS_SECRET, 'access');

export const verifyRefreshToken = (token: string): RefreshTokenClaims =>
  verify<RefreshTokenClaims>(token, env.JWT_REFRESH_SECRET, 'refresh');

/**
 * Refresh tokens are stored as SHA-256 digests. A leaked database dump then
 * cannot be used to mint sessions. SHA-256 (not bcrypt) is correct here: the
 * input is 256+ bits of server-generated entropy, so there is nothing to
 * brute-force and the lookup has to be a fast indexed equality check.
 */
export const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
