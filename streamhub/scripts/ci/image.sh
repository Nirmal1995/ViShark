#!/usr/bin/env bash
# CI stage "API image": builds the API container image, scans it, and starts
# it once to prove it runs (not only that it builds).
#
# The image is not pushed anywhere yet. Pushing to Amazon ECR comes with the
# deployment work, using the Jenkins instance's IAM role (no access keys).
# shellcheck source=../lib/common.sh
source "$(dirname "$0")/../lib/common.sh"
require_cmd docker
require_cmd trivy

revision="$(git rev-parse --short=12 HEAD)"
image="streamhub-api:${revision}"
out="reports/security"
mkdir -p "$out"

info "building $image"
docker build --pull -f apps/api/Dockerfile -t "$image" -t streamhub-api:ci \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --label "org.opencontainers.image.source=streamhub" \
  .
docker image ls "$image" --format 'size: {{.Size}}'

info "image runs as a non-root user"
uid="$(docker run --rm --entrypoint id "$image" -u)"
[ "$uid" != "0" ] || die "image runs as root"
ok "uid $uid"

info "trivy image: OS packages and Node dependencies"
if trivy image --cache-dir "${TRIVY_CACHE_DIR:-$HOME/.cache/trivy}" --no-progress \
  --severity HIGH,CRITICAL --ignore-unfixed --ignorefile .trivyignore \
  --scanners vuln,secret --format json --output "$out/trivy-image.json" --exit-code 1 "$image"; then
  ok "trivy image: nothing high or critical"
else
  trivy convert --format table "$out/trivy-image.json" || true
  die "trivy image: findings (see $out/trivy-image.json)"
fi

info "smoke test: start the container with throwaway settings"
name="streamhub-api-smoke-${revision}"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# No database here on purpose: the process must start, answer liveness, and
# report itself not ready, instead of crashing.
docker run -d --name "$name" -p 127.0.0.1::4000 \
  -e MONGO_URL=mongodb://smoke:smoke@127.0.0.1:1/smoke \
  -e REDIS_URL=redis://127.0.0.1:1 \
  -e SESSION_SECRET="$(openssl rand -hex 24)" \
  -e MFA_ENCRYPTION_KEY="$(openssl rand -hex 24)" \
  -e WEB_ORIGIN=https://streamhub.invalid \
  "$image" >/dev/null
port="$(docker port "$name" 4000/tcp | head -1 | awk -F: '{print $NF}')"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$port/health/live" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/health/live" >/dev/null || { docker logs "$name"; die "liveness failed"; }
ok "liveness: 200"
ready="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health/ready")"
[ "$ready" = "503" ] || { docker logs "$name"; die "readiness should be 503 without dependencies, got $ready"; }
ok "readiness: 503 without dependencies, as expected"
docker logs "$name" 2>&1 | grep -q '"level":"info".*api listening' || die "no structured JSON log line"
ok "structured JSON logs"
ok "image $image built, scanned and smoke tested"

# Hand the exact tested image to the deploy job ("build once, deploy the same
# artifact"): the deploy job loads this archive instead of rebuilding.
if [ -n "${IMAGE_ARCHIVE:-}" ]; then
  info "saving $image to $IMAGE_ARCHIVE"
  mkdir -p "$(dirname "$IMAGE_ARCHIVE")"
  docker save "$image" | gzip -1 > "$IMAGE_ARCHIVE"
  echo "$image" > "${IMAGE_ARCHIVE%.tar.gz}.ref"
  ok "archive: $(du -h "$IMAGE_ARCHIVE" | cut -f1)"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### API image"
    echo "| | |"; echo "|---|---|"
    echo "| Tag | \`$image\` |"
    echo "| Size | $(docker image ls "$image" --format '{{.Size}}') |"
    echo "| Runs as uid | $uid |"
    echo "| Trivy (high, critical) | none |"
  } >> "$GITHUB_STEP_SUMMARY"
fi
