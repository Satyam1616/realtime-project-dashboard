#!/bin/sh
# ---------------------------------------------------------------------------
# Container entrypoint.
#
# Both steps are opt-in through environment variables rather than being wired
# into the image, because "apply migrations on start" is the right behaviour for
# a single-container demo and the wrong behaviour for a fleet — there, schema
# changes are a deploy step run once, not something every replica races to do.
# docker-compose.yml turns both on; a real deployment would not.
# ---------------------------------------------------------------------------
set -e

if [ "${RUN_MIGRATIONS_ON_BOOT}" = "true" ]; then
  echo "[entrypoint] applying database migrations"
  # `migrate deploy` is the non-interactive form: it applies pending migrations,
  # never generates or edits SQL, never resets, and is a no-op once the database
  # is current — so a restart loop cannot damage data.
  npx --no-install prisma migrate deploy
fi

if [ "${SEED_ON_BOOT}" = "true" ]; then
  echo "[entrypoint] seeding"
  # The compiled seed, not `prisma db seed` — that would shell out to `tsx`,
  # which is a dev dependency and is deliberately absent from this image.
  #
  # The seed rebuilds its fixture from scratch, so it refuses to run against a
  # non-empty database under NODE_ENV=production unless SEED_FORCE=true. That
  # makes this safe to leave enabled: a first boot populates an empty volume, a
  # restart leaves real data alone.
  node dist/prisma/seed.js
fi

exec "$@"
