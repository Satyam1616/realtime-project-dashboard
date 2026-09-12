/**
 * Environment loading + validation.
 *
 * Every secret and connection string the app needs is declared here and parsed
 * once at boot. If anything required is missing or malformed the process exits
 * immediately with a readable message instead of failing later at the first
 * request. Nothing in the codebase reads `process.env` directly — modules import
 * the frozen, typed `env` object below, which makes it impossible to smuggle in a
 * hardcoded fallback secret.
 */
import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const nonEmpty = (name: string) => z.string({ error: `${name} is required` }).trim().min(1, `${name} must not be empty`);

/** Secrets must be long enough that a brute-force on the HMAC key is not the weakest link. */
const secret = (name: string) =>
  nonEmpty(name).min(32, `${name} must be at least 32 characters (generate with: openssl rand -base64 48)`);

const csvOrigins = z
  .string()
  .default('http://localhost:5173')
  .transform((raw) =>
    raw
      .split(',')
      .map((origin) => origin.trim().replace(/\/$/, ''))
      .filter((origin) => origin.length > 0),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: nonEmpty('DATABASE_URL'),

  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
  /** Short-lived: an access token is a bearer credential held in browser memory. */
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  /** Long-lived but single-use: rotated on every refresh (see modules/auth/auth.service.ts). */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  /** Cookie attributes. `COOKIE_DOMAIN` is only needed for cross-subdomain deploys. */
  COOKIE_NAME: z.string().default('velozity_rt'),
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined)),
  /**
   * Cross-site cookie delivery. The reference deployment puts the SPA on Vercel
   * and the API on a different host, so the refresh cookie must be
   * `SameSite=None; Secure` to be sent at all. Locally both sides are
   * `localhost`, so `lax` works and does not require HTTPS.
   */
  COOKIE_CROSS_SITE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  CORS_ORIGINS: csvOrigins,

  /** Cron expression for the overdue-task sweep. Default: every 5 minutes. */
  OVERDUE_CRON: z.string().default('*/5 * * * *'),
  /** Lets tests and one-off scripts import the app without starting timers. */
  ENABLE_SCHEDULER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Only used by `prisma/seed.ts`; never referenced by request-handling code. */
  SEED_PASSWORD: z.string().default('Password123!'),
  /**
   * Lets the seed rebuild a non-empty production database.
   *
   * `SEED_ON_BOOT=true` in docker-compose runs with `NODE_ENV=production`, so
   * the seed refuses to wipe a database that already has users unless this is
   * set. First boot (empty database) is seeded either way.
   */
  SEED_FORCE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Deliberately not using the app logger: it does not exist yet at this point.
  console.error(`\nInvalid environment configuration:\n${details}\n\nCopy server/.env.example to server/.env and fill it in.\n`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
