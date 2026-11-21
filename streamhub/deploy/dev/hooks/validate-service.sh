#!/usr/bin/env bash
# The deployment succeeds only if the new version is really serving:
#   - the API container runs exactly the image this revision pins
#   - /health/ready answers 200 (MongoDB Atlas and Redis reachable)
# A failure here fails the deployment; the deployment group then rolls back
# to the previous revision automatically.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
load_release

container="$("${COMPOSE[@]}" ps --quiet api)"
[ -n "$container" ] || die "api container is not running"
running="$(docker inspect --format '{{.Image}}' "$container")"
expected="$(docker image inspect --format '{{.Id}}' "$API_IMAGE")"
[ "$running" = "$expected" ] || die "api runs $running, expected $expected"
log "api runs the pinned image"

for attempt in $(seq 1 40); do
  status="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/health/ready || true)"
  if [ "$status" = 200 ]; then
    log "ready after $attempt check(s)"
    exit 0
  fi
  sleep 3
done
curl -s http://127.0.0.1:4000/health/ready || true
echo
"${COMPOSE[@]}" logs --tail 30 api || true
die "api not ready after 120 seconds (last status $status)"
