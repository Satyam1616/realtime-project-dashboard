/**
 * Prisma CLI configuration (Prisma 7).
 *
 * In v7 the connection URL is no longer allowed in `schema.prisma`, so this file
 * is what `prisma migrate`, `prisma db seed` and `prisma studio` read. The
 * application runtime does *not* use this file — it connects through the `pg`
 * driver adapter in `src/db/client.ts`.
 *
 * `process.env.DATABASE_URL` is read directly rather than via Prisma's `env()`
 * helper, because `env()` throws when the variable is absent and that would
 * break `prisma generate` — which needs no database at all, and runs in CI and
 * in the Docker build where no URL is set.
 */
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // v7 no longer seeds automatically after `migrate dev` / `migrate reset`;
    // this is what `prisma db seed` (and `npm run db:seed`) invokes.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL as string,
  },
});
