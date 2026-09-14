# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# API image.
#
# Built from the REPOSITORY ROOT (see docker-compose.yml: `context: .`) because
# this is an npm workspaces monorepo — the lockfile that pins every version
# lives at the root, and building from `server/` alone would have to resolve
# dependencies afresh and could silently drift from what was tested.
#
#   docker build -f server/Dockerfile -t velozity-api .
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# Manifests and lockfile first, so the (slow) dependency install is cached until
# a dependency actually changes rather than on every source edit.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

# The Prisma schema is copied *before* `npm ci` on purpose: the server's
# `postinstall` runs `prisma generate`, which needs the schema and the config to
# exist. Without this the install fails inside the image even though it works on
# a developer's machine, where the schema is simply already there.
COPY server/prisma ./server/prisma
COPY server/prisma.config.ts ./server/

RUN npm ci

# Sources last — editing a route invalidates only the layers below this line.
COPY server/src ./server/src
COPY server/tsconfig.json server/tsconfig.build.json ./server/

# Compiles the API *and* the seed (see server/tsconfig.build.json): the runtime
# image runs type-checked JavaScript, never `tsx` over raw TypeScript.
RUN npm run build --workspace server

# Strip dev dependencies in place. `npm prune` respects the workspace layout, so
# what remains is exactly the production tree the lockfile pinned.
RUN npm prune --omit=dev

# npm hoists everything it can to the root `node_modules`, and only nests a
# package under `server/node_modules` when a version conflict forces it. Whether
# anything nests there is therefore a property of the resolved dependency graph,
# not of this project — it changes when the lockfile is regenerated, and after
# pruning dev dependencies the directory is usually absent entirely. The runtime
# stage copies it unconditionally and Docker fails a COPY whose source does not
# exist, so guarantee the path rather than letting a hoisting change break the
# build. An empty directory costs nothing; Node just falls through it to
# /app/node_modules when resolving.
RUN mkdir -p server/node_modules

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# `dumb-init` reaps zombies and, critically, forwards SIGTERM: without a real
# init at PID 1 the graceful shutdown in src/index.ts never runs and
# `docker stop` kills the container after the grace period instead.
RUN apk add --no-cache dumb-init

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/dist ./server/dist

# The schema, the migration SQL and the Prisma config ship with the image so the
# container can bring an empty database up to the current schema on its own,
# without the repository being mounted.
COPY --from=builder /app/server/prisma ./server/prisma
COPY --from=builder /app/server/prisma.config.ts ./server/

COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The base image ships an unprivileged `node` user; nothing here needs root.
USER node
WORKDIR /app/server
EXPOSE 4000

# Hits the same unauthenticated liveness route the load balancer would use.
# Written with `fetch` rather than curl/wget so the image needs no extra package.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
