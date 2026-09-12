/**
 * Test configuration.
 *
 * Two tiers of test live under `test/`, and they have different needs:
 *
 *   - `rbac.test.ts` and `realtime.fanout.test.ts` are pure: no database, no
 *     sockets, no network. They are the fast feedback loop over the rules that
 *     matter most, and they run anywhere `npm install` has run.
 *
 *   - `access.integration.test.ts` drives the real Fastify app against the real
 *     seeded database, because the claim being tested — "a developer cannot
 *     reach a manager's data by hitting the endpoint directly" — is only
 *     meaningful end to end. A unit test of the scope helpers cannot prove the
 *     handler actually applied them.
 *
 * `fileParallelism: false` because the integration file logs users in, mutates
 * task status and reads the activity log; a second file racing it against the
 * same Postgres would produce failures that say nothing about the code. The
 * pure files are fast enough that serialising them costs nothing.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The app's own env loader (src/config/env.ts) reads .env on import, so
    // there is no setup file to keep in sync with it.
    fileParallelism: false,
    // Logging in with bcrypt at 12 rounds is deliberately slow, and the
    // integration file does it once per role.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
