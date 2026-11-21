#!/usr/bin/env bash
# Shared helpers for the CodeDeploy hooks. Sourced, not executed.
# Hook output goes to the CodeDeploy agent log and the console's "log tail":
# never print secret values here.
# shellcheck disable=SC2034 # the variables are used by the scripts that source this
set -euo pipefail

RELEASE_DIR=/opt/streamhub/release
# Root-only directory on the encrypted EBS volume. Not tmpfs on purpose:
# containers restart after a reboot and Redis needs its config file then.
RUNTIME_DIR=/etc/streamhub
PARAMETER_PATH=/streamhub/dev/
COMPOSE=(docker compose --project-directory "$RELEASE_DIR" -f "$RELEASE_DIR/compose.yaml"
  --env-file "$RELEASE_DIR/release.env")

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

load_release() {
  [ -f "$RELEASE_DIR/release.env" ] || die "release.env missing from the revision"
  # shellcheck disable=SC1091
  source "$RELEASE_DIR/release.env"
  [[ "${API_IMAGE:-}" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] ||
    die "API_IMAGE must be an ECR image pinned by digest"
}

# Region of this instance, from the instance metadata service (IMDSv2).
instance_region() {
  local token
  token="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
  curl -fsS -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/placement/region
}

ecr_login() { # registry, region
  aws ecr get-login-password --region "$2" | docker login --username AWS --password-stdin "$1" >/dev/null
}
