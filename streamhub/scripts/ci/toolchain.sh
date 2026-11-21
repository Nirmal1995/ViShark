#!/usr/bin/env bash
# CI stage "Toolchain": proves the build host has exactly the tools the
# pipeline expects, before spending time on the build. Prints every version
# into the build log, so a failing build always shows what it ran with.
# shellcheck source=../lib/common.sh
source "$(dirname "$0")/../lib/common.sh"
# shellcheck source=versions.sh
source "$(dirname "$0")/versions.sh"

problems=0
check() { # name, actual, expected (prefix match)
  if [[ "$2" == "$3"* ]]; then ok "$1 $2"; else fail "$1 is '$2', expected $3"; problems=$((problems + 1)); fi
}

for cmd in node pnpm git docker gitleaks trivy; do
  command -v "$cmd" >/dev/null 2>&1 || { fail "$cmd not found on PATH"; problems=$((problems + 1)); }
done
[ "$problems" -eq 0 ] || die "missing tools; see docs/operations/jenkins-on-ec2.md"

check node "$(node --version)" "v${CI_NODE_MAJOR}."
check pnpm "$(pnpm --version)" "$CI_PNPM_VERSION"
check gitleaks "$(gitleaks version)" "$CI_GITLEAKS_VERSION"
check trivy "$(trivy --version | head -1 | awk '{print $2}')" "$CI_TRIVY_VERSION"

wait_for_docker 60
compose="$(docker compose version --short 2>/dev/null || true)"
if [ -z "$compose" ]; then fail "docker compose plugin missing"; problems=$((problems + 1));
else ok "docker $(docker version --format '{{.Server.Version}}'), compose $compose"; fi
if docker buildx version >/dev/null 2>&1; then ok "buildx $(docker buildx version | awk '{print $2}')"
else fail "docker buildx plugin missing"; problems=$((problems + 1)); fi

info "disk free on workspace: $(df -h . | awk 'NR==2 {print $4}')"
[ "$problems" -eq 0 ] || die "$problems toolchain problem(s)"
ok "toolchain matches the pinned versions"
