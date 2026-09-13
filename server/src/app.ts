/**
 * Fastify application factory.
 *
 * **Why Fastify rather than Express** (expanded in README.md): three reasons that
 * actually bite in this app rather than benchmark trivia —
 *
 *   1. *Encapsulation.* Each module registers as a plugin with its own prefix and
 *      its own hooks. `app.addHook('preHandler', app.authenticate)` inside
 *      `projects.routes.ts` applies to that subtree and nowhere else, so an
 *      unauthenticated route cannot be added to a protected module by accident.
 *      Express middleware ordering is positional and global by default, which is
 *      exactly the shape that produces a forgotten guard.
 *   2. *Async-native error handling.* A rejected promise in a handler reaches
 *      `setErrorHandler` without a wrapper. In Express 4 an un-awaited rejection
 *      silently hangs the request, and the usual fix is a `catchAsync` helper
 *      wrapped around every route by hand.
 *   3. *First-party plugins for the security surface* — helmet, cors, cookie and
 *      rate-limit are maintained alongside the framework and share its lifecycle.
 *
 * The factory returns an app with no listener attached, so tests can drive it
 * through `app.inject()` and `index.ts` can attach Socket.IO to the same HTTP
 * server the routes are served from.
 */
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env, isProduction, isTest } from './config/env.js';
import { badRequest, forbidden } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import authPlugin from './plugins/auth.plugin.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { userRoutes } from './modules/users/users.routes.js';
import { clientRoutes } from './modules/clients/clients.routes.js';
import { projectRoutes } from './modules/projects/projects.routes.js';
import { taskRoutes } from './modules/tasks/tasks.routes.js';
import { activityRoutes } from './modules/activity/activity.routes.js';
import { notificationRoutes } from './modules/notifications/notification.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';

export const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    // Widened to `FastifyBaseLogger` on purpose: passing the pino instance
    // unannotated makes Fastify infer a narrower `Logger` generic, and every
    // helper that accepts a plain `FastifyInstance` then stops type-checking.
    loggerInstance: logger as FastifyBaseLogger,
    // Behind Vercel/Render/Fly the client IP is in `X-Forwarded-For`; without
    // this the rate limiter would bucket every request under the proxy's IP.
    trustProxy: true,
    // Fastify's default id is a counter, which collides across instances. A
    // request id is the only handle a user has on a 500, so it must be unique.
    genReqId: () => crypto.randomUUID(),
    /**
     * Per-request log lines are suppressed under `NODE_ENV=test` so a suite's
     * output is its assertions rather than 300 lines of `incoming request`.
     *
     * Passed as a `LogController` instance rather than the top-level
     * `disableRequestLogging` flag, which Fastify 5 deprecates (FSTDEP023) and
     * removes in Fastify 6.
     */
    logController: new LogController({ disableRequestLogging: isTest }),
    bodyLimit: 1_048_576, // 1 MiB — this API never receives uploads.
  });

  /* ---------------------------------------------------------------- *
   * Security and transport
   * ---------------------------------------------------------------- */

  await app.register(helmet, {
    // The API serves JSON only and is on a different origin from the SPA, so
    // the document-oriented policies do not apply to it. CSP for the frontend is
    // set by the frontend's own host.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  /**
   * CORS with `credentials: true` and an explicit origin allowlist — required,
   * because the refresh token travels as a cookie and a browser will not send
   * one to a wildcard origin.
   */
  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin requests, curl and the health check send no Origin header.
      if (!origin) return callback(null, true);
      const normalised = origin.replace(/\/$/, '');
      if (env.CORS_ORIGINS.includes(normalised)) return callback(null, true);
      // An `AppError` rather than a bare `Error`, for two reasons: a bare one
      // reaches the client as Fastify's own `{statusCode, error, message}` shape
      // and a 500, which breaks the single response envelope this API promises
      // and blames the server for what is a caller mistake. It is also not
      // logged as an unhandled fault, so a misconfigured `CORS_ORIGINS` shows up
      // as a 403 in the access log instead of a stack trace per request.
      return callback(forbidden(`Origin ${normalised} is not allowed.`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie);

  /**
   * Accept an empty body on a request that still declares
   * `Content-Type: application/json`.
   *
   * Fastify's default parser rejects that combination outright
   * (`FST_ERR_CTP_EMPTY_JSON_BODY`), which is correct by the letter of the spec —
   * `""` is not valid JSON — but it breaks every bodyless POST in this API
   * (`/notifications/:id/read`, `/notifications/read-all`, `/auth/logout`,
   * `/auth/refresh`) the moment a client sets a default JSON content type, which
   * axios and most fetch wrappers do without being asked.
   *
   * No validation is lost. An empty body becomes `undefined`, `parseBody()`
   * turns that into `{}`, and a route that genuinely requires fields still fails
   * its own Zod schema with per-field details. Malformed non-empty JSON is still
   * a 400, now in the same envelope as every other error rather than Fastify's.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, payload, done) => {
    const raw = typeof payload === 'string' ? payload.trim() : '';
    if (raw.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(badRequest('Request body must be valid JSON.'));
    }
  });

  /**
   * A blanket limit; `/auth/login` and `/auth/refresh` tighten it per-route.
   * Skipped in tests, where a suite hammering the same endpoint would otherwise
   * start failing on 429 rather than on the thing under test.
   */
  await app.register(rateLimit, {
    global: !isTest,
    max: 300,
    timeWindow: '1 minute',
    // Authenticated callers are bucketed by identity, anonymous ones by IP, so
    // one noisy office NAT cannot rate-limit a whole team.
    keyGenerator: (request) => request.principal?.id ?? request.ip,
  });

  /* ---------------------------------------------------------------- *
   * Errors and authentication
   * ---------------------------------------------------------------- */

  registerErrorHandler(app);
  await app.register(authPlugin);

  /* ---------------------------------------------------------------- *
   * Routes
   * ---------------------------------------------------------------- */

  /** Liveness probe — deliberately outside `/api` and unauthenticated. */
  app.get('/health', async () => ({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    environment: env.NODE_ENV,
  }));

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(clientRoutes, { prefix: '/clients' });
      await api.register(projectRoutes, { prefix: '/projects' });
      await api.register(taskRoutes, { prefix: '/tasks' });
      await api.register(activityRoutes, { prefix: '/activity' });
      await api.register(notificationRoutes, { prefix: '/notifications' });
      await api.register(dashboardRoutes, { prefix: '/dashboard' });
    },
    { prefix: '/api' },
  );

  if (!isProduction) {
    app.log.debug('routes registered');
  }

  return app;
};
