#!/usr/bin/env bash
# CI stage "Integration tests": starts a throwaway MongoDB, Redis, storage
# and Mailpit with Docker Compose, runs the integration tests against them,
# and always removes containers, volumes and the generated .env afterwards.
#
# The .env here is created fresh with random values for this build only. It
# is never a copy of anyone's real configuration, and it is deleted on exit.
# shellcheck source=../lib/common.sh
source "$(dirname "$0")/../lib/common.sh"

# On GitHub Actions, also annotate failing tests in the pull request.
gh_reporter=()
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then gh_reporter=(--reporter=github-actions); fi
require_cmd docker

# Protect a developer's real .env if someone runs this on their own machine.
if [ -f .env ] && [ "${CI:-}" != "true" ]; then
  die ".env exists. This script creates and deletes its own .env; run it in CI only (CI=true)."
fi

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-streamhub-ci}"
cleanup() {
  local status=$?
  info "cleanup: removing containers, volumes and .env"
  if [ "$status" -ne 0 ]; then docker compose ps -a || true; docker compose logs --tail 50 || true; fi
  docker compose down --volumes --remove-orphans --timeout 10 || true
  rm -f .env
  exit "$status"
}
trap cleanup EXIT

rm -f .env
bash scripts/init-env.sh
wait_for_docker 60
info "starting services (project $COMPOSE_PROJECT_NAME)"
start_infrastructure 240

info "integration tests"
pnpm -r test:integration --reporter=default "${gh_reporter[@]}" --reporter=junit \
  --outputFile.junit=reports/junit-integration.xml
ok "integration tests passed"
