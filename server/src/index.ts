/**
 * Process bootstrap.
 *
 * Order matters here:
 *
 *   1. `buildApp()` then `app.ready()` — Fastify creates its HTTP server up
 *      front, but plugins must finish registering before anything is served.
 *   2. Socket.IO attaches to **that same** `http.Server`. One port, one origin,
 *      one CORS policy, and the WebSocket upgrade rides the connection the SPA
 *      already has open. Running a second server on a second port would mean a
 *      second CORS configuration and a second thing to deploy.
 *   3. `app.listen()` — only now does anything reach a handler.
 *   4. The scheduler starts last, so a boot sweep cannot fire against a
 *      half-initialised process.
 *
 * Shutdown runs in reverse, with a hard timeout: a container orchestrator will
 * SIGKILL us eventually, and it is better to exit deliberately than to be shot
 * mid-transaction.
 */
import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma, prisma } from './db/client.js';
import { createSocketServer, getIO, setIO } from './realtime/socket.server.js';
import { resetPresence } from './realtime/presence.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const start = async (): Promise<void> => {
  // Fail fast with a clear message rather than surfacing a connection error on
  // the first request a user makes.
  await prisma.$queryRaw`SELECT 1`;

  const app = await buildApp();
  await app.ready();

  const io = createSocketServer(app.server);

  await app.listen({ port: env.PORT, host: env.HOST });

  startScheduler();

  logger.info(
    { port: env.PORT, env: env.NODE_ENV, origins: env.CORS_ORIGINS },
    'API and WebSocket server listening',
  );

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');

    const timer = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    try {
      await stopScheduler();

      // Close sockets before HTTP: `io.close()` disconnects every client, which
      // lets their reconnect backoff start immediately rather than after a
      // timeout on a socket that is already gone.
      await new Promise<void>((resolve) => io.close(() => resolve()));
      setIO(null);
      resetPresence();

      await app.close();
      await disconnectPrisma();

      clearTimeout(timer);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  /**
   * A process in an unknown state must not keep serving requests: it may hold a
   * half-applied transaction or a corrupted in-memory presence map. Log it in
   * full, then let the supervisor restart us clean.
   */
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
};

start().catch((error: unknown) => {
  // `getIO()` may be set if the failure happened after the socket server was
  // created; closing it prevents a dangling handle from keeping the process up.
  getIO()?.close();
  logger.fatal({ err: error }, 'failed to start server');
  process.exit(1);
});
