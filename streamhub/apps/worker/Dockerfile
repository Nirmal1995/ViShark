# syntax=docker/dockerfile:1
#
# StreamHub worker image (FFmpeg transcoding, ADR-047). Build from the
# repository root:
#
#   docker build -f apps/worker/Dockerfile -t streamhub-worker:dev .
#
# Same layout as the API image: build, production dependencies, then a clean
# runtime with FFmpeg from Debian. No ports, no shell scripts: one Node process
# that runs FFmpeg as child processes.
ARG NODE_IMAGE=node:26-trixie-slim

FROM ${NODE_IMAGE} AS base
RUN npm install -g pnpm@12.18.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/shared/package.json packages/shared/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@streamhub/worker..."
COPY tsconfig.base.json ./
COPY packages/contracts/src packages/contracts/src
COPY packages/shared/src packages/shared/src
COPY apps/worker/tsconfig.json apps/worker/tsconfig.build.json apps/worker/
COPY apps/worker/src apps/worker/src
RUN pnpm --filter @streamhub/worker build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter "@streamhub/worker..."

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# FFmpeg (and ffprobe) from Debian, plus pending security updates; npm, npx
# and corepack removed as in the API image (never used at runtime).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade --no-install-recommends \
 && DEBIAN_FRONTEND=noninteractive apt-get -y install --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=prod-deps --chown=root:root /app /app
COPY --chown=root:root packages/contracts/src packages/contracts/src
COPY --chown=root:root packages/shared/src packages/shared/src
COPY --from=build --chown=root:root /app/apps/worker/dist apps/worker/dist

# Code is root-owned and read-only to the "node" user (uid 1000). Scratch
# files go to /tmp (on Fargate: the task's ephemeral storage).
USER node
CMD ["node", "apps/worker/dist/main.js"]
