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
  #
  # Retried, because on a managed host the database and the container start at
  # the same time and the database is routinely still accepting connections when
  # the first attempt lands. That failure is P1001 ("Can't reach database
  # server"), which is the same error a genuinely unreachable database gives, so
  # the distinction is only how long it persists. Bounded rather than infinite:
  # after ~2 minutes this is a real misconfiguration — most often the database
  # sitting in a different region from the service — and the right outcome is a
  # loud failure, not a container that retries quietly forever.
  attempt=1
  max_attempts=12
  until npx --no-install prisma migrate deploy; do
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "[entrypoint] database unreachable after ${max_attempts} attempts — giving up."
      echo "[entrypoint] if this is P1001, check that the database and this service are in the SAME region."
      exit 1
    fi
    echo "[entrypoint] migrate failed (attempt ${attempt}/${max_attempts}); retrying in 10s"
    attempt=$((attempt + 1))
    sleep 10
  done
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
