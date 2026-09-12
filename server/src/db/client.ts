/**
 * Prisma client singleton and the app's single import seam for generated types.
 *
 * Every module imports `prisma`, the enums and `Prisma` from *here* rather than
 * reaching into `src/generated/prisma` directly. That keeps the generated-code
 * path — which Prisma 7 requires you to choose, and which we may well move —
 * mentioned in exactly one file.
 *
 * Prisma 7 requires a driver adapter for every datasource, so the connection is
 * owned by `pg` and its pool settings are ours to tune (v6's implicit
 * Rust-engine pool is gone).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env, isProduction, isTest } from '../config/env.js';

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  // `pg` defaults to no connection timeout at all; a hung DB would otherwise
  // hang requests indefinitely instead of failing them.
  connectionTimeoutMillis: 10_000,
  max: isProduction ? 10 : 5,
});

export const prisma = new PrismaClient({
  adapter,
  log: isTest ? [] : isProduction ? ['warn', 'error'] : ['warn', 'error'],
});

export const disconnectPrisma = (): Promise<void> => prisma.$disconnect();

/**
 * Re-exports.
 *
 * The generated `client.ts` is a barrel over the enums, model types and the
 * `Prisma` namespace (which carries the `where`/`select` input types used by the
 * authorisation scopes in src/access/rbac.ts), so one import covers everything.
 */
export { Prisma } from '../generated/prisma/client.js';
export { Role, TaskStatus, TaskPriority, ProjectStatus, ActivityType, NotificationType } from '../generated/prisma/client.js';
export type {
  User,
  Client,
  Project,
  ProjectMember,
  Task,
  ActivityEvent,
  ActivityCursor,
  Notification,
  RefreshToken,
} from '../generated/prisma/client.js';
