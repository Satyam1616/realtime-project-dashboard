/**
 * The refresh-token cookie.
 *
 * The refresh token is the long-lived credential, so it is deliberately *not*
 * reachable from JavaScript: `HttpOnly` means an XSS payload cannot read it, and
 * that is the whole reason for not keeping it in `localStorage`. The access
 * token, which is short-lived and held only in a JS variable, is the one the
 * client attaches to requests.
 *
 * `path` is narrowed to the auth routes so the browser does not attach this
 * credential to every API call that has no use for it — it is only sent where it
 * is actually redeemed.
 */
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import { env, isProduction } from '../../config/env.js';

/** Only the endpoints that redeem or clear the cookie live under this prefix. */
export const REFRESH_COOKIE_PATH = '/api/auth';

const baseOptions = (): CookieSerializeOptions => ({
  httpOnly: true,
  /**
   * `SameSite=None` is required when the SPA and API are on different sites
   * (Vercel + a container host), and browsers only accept `None` together with
   * `Secure`. Locally both are on `localhost`, where `lax` works over plain
   * HTTP and still blocks cross-site sends.
   */
  sameSite: env.COOKIE_CROSS_SITE ? 'none' : 'lax',
  secure: env.COOKIE_CROSS_SITE || isProduction,
  path: REFRESH_COOKIE_PATH,
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

export const setRefreshCookie = (reply: FastifyReply, token: string): void => {
  reply.setCookie(env.COOKIE_NAME, token, {
    ...baseOptions(),
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
};

export const clearRefreshCookie = (reply: FastifyReply): void => {
  // Attributes must match the ones used to set it, or the browser keeps the
  // original cookie alongside the expired one.
  reply.setCookie(env.COOKIE_NAME, '', { ...baseOptions(), maxAge: 0, expires: new Date(0) });
};

export const readRefreshCookie = (cookies: Record<string, string | undefined>): string | null =>
  cookies[env.COOKIE_NAME] ?? null;
