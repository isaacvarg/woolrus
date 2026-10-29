# syntax=docker/dockerfile:1
# One Dockerfile, three images:
#   docker build -f docker/Dockerfile --target web .
#   docker build -f docker/Dockerfile --target worker .
#   docker build -f docker/Dockerfile --target migrate .

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-alpine AS base
RUN npm install -g pnpm@12.11.2 && apk add --no-cache libc6-compat
WORKDIR /repo

# --- Install and build -------------------------------------------------------
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/i18n/package.json packages/i18n/
COPY packages/logger/package.json packages/logger/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
# prisma generate reads the config, which needs some DATABASE_URL; it never connects.
ENV DATABASE_URL=postgresql://build@localhost/build NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo run build --filter=@woolrus/web --filter=@woolrus/worker
RUN pnpm --filter=@woolrus/worker deploy --prod /out/worker \
 && pnpm --filter=@woolrus/db deploy /out/db

# --- Web ---------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 SERVICE_NAME=web NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "apps/web/server.js"]

# --- Worker ------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production SERVICE_NAME=worker
COPY --from=build --chown=node:node /out/worker ./
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
USER node
# The heartbeat job touches this file every minute; a worker that stops consuming jobs goes stale.
HEALTHCHECK --interval=60s CMD find /tmp/worker-heartbeat -mmin -3 | grep -q .
CMD ["node", "dist/main.mjs"]

# --- Migrations (runs once per deploy, before web and worker start) -----------
FROM node:${NODE_VERSION}-alpine AS migrate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out/db ./
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]
