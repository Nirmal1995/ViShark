#!/usr/bin/env bash
# Replaces the running containers with the new version. Compose recreates
# only services whose image or configuration changed; --wait returns once
# their health checks pass (the API image's liveness check).
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
load_release
"${COMPOSE[@]}" up --detach --remove-orphans --wait --wait-timeout 120
log "containers up"
# Keep the disk from filling up with old images. Rollbacks pull from ECR, so
# nothing needed is lost.
docker image prune --all --force --filter "until=168h" >/dev/null
