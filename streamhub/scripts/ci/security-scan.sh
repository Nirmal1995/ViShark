#!/usr/bin/env bash
# CI stage "Security scans". Any finding fails the build; reports go to
# reports/security/ and are archived by Jenkins.
#
#   1. gitleaks: secrets in the whole git history (not just the latest commit:
#      a key that was committed and then deleted is still leaked)
#   2. pnpm audit: known vulnerabilities in dependencies, high and critical
#   3. trivy fs: vulnerable dependencies (lockfile), Dockerfile
#      misconfigurations and secrets in the working tree
#
# Accepted findings must be listed with a reason and an expiry date in
# .gitleaks.toml or .trivyignore, never by weakening this script.
# shellcheck source=../lib/common.sh
source "$(dirname "$0")/../lib/common.sh"
require_cmd gitleaks
require_cmd trivy

out="reports/security"
mkdir -p "$out"
failed=()

repo_root="$(git rev-parse --show-toplevel)"
info "gitleaks: scanning git history of $repo_root"
if gitleaks git "$repo_root" --config .gitleaks.toml --redact --no-banner \
  --report-format json --report-path "$out/gitleaks.json"; then
  ok "gitleaks: no secrets found"
else
  fail "gitleaks: secrets found (values are redacted in $out/gitleaks.json)"
  failed+=(gitleaks)
fi

info "pnpm audit: high and critical"
if pnpm audit --audit-level high --json > "$out/pnpm-audit.json"; then
  ok "pnpm audit: nothing high or critical"
else
  pnpm audit --audit-level high || true
  fail "pnpm audit: high or critical vulnerabilities"
  failed+=(pnpm-audit)
fi

info "trivy fs: dependencies, Dockerfile, secrets"
# shellcheck disable=SC2054 # "HIGH,CRITICAL" is one argument, not two elements
trivy_common=(--cache-dir "${TRIVY_CACHE_DIR:-$HOME/.cache/trivy}" --no-progress
  --severity HIGH,CRITICAL --ignore-unfixed --ignorefile .trivyignore)
if trivy fs "${trivy_common[@]}" --scanners vuln,misconfig,secret \
  --skip-dirs node_modules --skip-dirs reports --skip-files .env \
  --format json --output "$out/trivy-fs.json" --exit-code 1 . ; then
  ok "trivy fs: nothing high or critical"
else
  trivy convert --format table "$out/trivy-fs.json" || true
  fail "trivy fs: findings (see $out/trivy-fs.json)"
  failed+=(trivy-fs)
fi

[ "${#failed[@]}" -eq 0 ] || die "security scans failed: ${failed[*]}"
ok "security scans passed"
