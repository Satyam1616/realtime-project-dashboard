/**
 * Application logger.
 *
 * One pino instance, shared with Fastify (so request logs and job/socket logs
 * interleave in a single stream with consistent fields) and used directly by
 * code that has no request context — the cron scheduler and the WebSocket layer.
 *
 * Redaction is not optional: `authorization` headers and the refresh cookie are
 * credentials, and an access log that captures them turns log storage into a
 * secondary credential store.
 */
import { pino } from 'pino';
import { env, isProduction, isTest } from '../config/env.js';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'token',
      '*.token',
      'refreshToken',
      '*.refreshToken',
    ],
    censor: '[redacted]',
  },
  // Pretty output in development; newline-delimited JSON in production, where
  // something else (the platform's log pipeline) does the formatting.
  transport: isProduction || isTest ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});

export type Logger = typeof logger;
