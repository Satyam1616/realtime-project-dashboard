/**
 * Auth routes.
 *
 * Response bodies never contain the refresh token — it leaves the server only
 * as an `HttpOnly` `Set-Cookie` header. The access token *is* in the body,
 * because the client has to be able to attach it to requests; it is short-lived
 * and expected to live in memory only.
 */
import type { FastifyPluginAsync } from 'fastify';
import { parseBody } from '../../lib/validate.js';
import { requirePrincipal } from '../../plugins/auth.plugin.js';
import { unauthenticated } from '../../lib/errors.js';
import { changePasswordSchema, loginSchema, registerSchema } from './auth.schemas.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './auth.cookies.js';
import { changePassword, login, logout, refresh, register, toPublicUser } from './auth.service.js';
import { prisma } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Self-service registration.
   *
   * The tightest limit in the API: this is the only unauthenticated route that
   * *creates* a row, so an unbounded one is a way to fill the database from the
   * open internet. Five per hour per IP is generous for a person and useless for
   * a script.
   *
   * Every account created here is a developer — see `register()`. The response
   * is 201 with a session already established, and the refresh cookie set, so
   * the client is signed in without a second round trip.
   */
  app.post(
    '/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const input = parseBody(registerSchema, request.body);

      const result = await register(input, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });

      setRefreshCookie(reply, result.refreshToken);

      return reply.status(201).send({
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      });
    },
  );

  /**
   * Brute-force protection. Tighter than the global limit because this is the
   * one endpoint where guessing pays off.
   */
  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { email, password } = parseBody(loginSchema, request.body);

      const result = await login(email, password, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });

      setRefreshCookie(reply, result.refreshToken);

      return reply.send({
        user: result.user,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      });
    },
  );

  /**
   * Exchanges the cookie for a new access token and a rotated refresh cookie.
   * Rate-limited because a replay storm against this endpoint would otherwise
   * trigger family revocations for legitimate users.
   */
  app.post(
    '/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const raw = readRefreshCookie(request.cookies);
      if (!raw) {
        throw unauthenticated('No session cookie present.');
      }

      try {
        const result = await refresh(raw, {
          userAgent: request.headers['user-agent'],
          ip: request.ip,
        });

        setRefreshCookie(reply, result.refreshToken);

        return reply.send({
          user: result.user,
          accessToken: result.accessToken,
          expiresIn: result.expiresIn,
        });
      } catch (error) {
        // Any refresh failure leaves the browser holding a cookie that will
        // never work again; clearing it stops the client from retrying forever.
        clearRefreshCookie(reply);
        throw error;
      }
    },
  );

  app.post('/logout', async (request, reply) => {
    await logout(readRefreshCookie(request.cookies));
    clearRefreshCookie(reply);
    return reply.status(204).send();
  });

  /** Who am I — used on app boot to restore the session from the cookie. */
  app.get('/me', { preHandler: app.authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);

    const user = await prisma.user.findUnique({
      where: { id: principal.id },
      select: { id: true, email: true, name: true, role: true, avatarColor: true, jobTitle: true },
    });
    if (!user) throw notFound('User');

    return reply.send({ user: toPublicUser(user) });
  });

  app.post('/change-password', { preHandler: app.authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, request.body);

    await changePassword(principal.id, currentPassword, newPassword);

    // Every session, including this one, is now invalid.
    clearRefreshCookie(reply);
    return reply.status(204).send();
  });
};
