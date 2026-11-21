# syntax=docker/dockerfile:1
#
# StreamHub API image. Build from the repository root (the API needs the
# workspace packages):
#
#   docker build -f apps/api/Dockerfile -t streamhub-api:dev .
#
# Three stages keep the final image small and free of build tools:
#   build     installs every dependency and compiles TypeScript to dist/
#   prod-deps installs runtime dependencies only
#   runtime   copies the two results onto a clean base and runs as a non-root user
#
# Pin NODE_IMAGE to a digest in CI (node:26-trixie-slim@sha256:...) so a
# re-pushed tag cannot change what we build on.
ARG NODE_IMAGE=node:26-trixie-slim

FROM ${NODE_IMAGE} AS base
# Corepack is not bundled with Node 25+, so pnpm is installed explicitly, at
# the exact version in package.json "packageManager".
RUN npm install -g pnpm@12.18.0 && npm cache clean --force
WORKDIR /app
# Only the files that decide what gets installed: this layer stays cached
# until a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/shared/package.json packages/shared/

FROM base AS build
# "@streamhub/api..." = the API and the workspace packages it depends on.
RUN pnpm install --frozen-lockfile --filter "@streamhub/api..."
COPY tsconfig.base.json ./
COPY packages/contracts/src packages/contracts/src
COPY packages/shared/src packages/shared/src
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
RUN pnpm --filter @streamhub/api build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter "@streamhub/api..."

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_METRICS_HOST=0.0.0.0
WORKDIR /app
# Manifests plus production node_modules for every workspace package that has
# dependencies. pnpm's node_modules are symlinks into node_modules/.pnpm; COPY
# keeps them as symlinks.
COPY --from=prod-deps --chown=root:root /app /app
# Workspace packages ship as TypeScript source; Node runs them directly with
# its built-in type stripping (they use erasable syntax only).
COPY --chown=root:root packages/contracts/src packages/contracts/src
COPY --chown=root:root packages/shared/src packages/shared/src
COPY --chown=root:root apps/api/assets apps/api/assets
COPY --from=build --chown=root:root /app/apps/api/dist apps/api/dist

# Files are owned by root and read-only to the app user: a compromised process
# cannot modify its own code. The base image's "node" user (uid 1000) runs it.
USER node
EXPOSE 4000 4001
# Liveness only (no dependencies), using Node's fetch: no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/server.js"]
