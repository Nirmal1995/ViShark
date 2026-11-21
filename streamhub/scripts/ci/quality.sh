#!/usr/bin/env bash
# CI stage "Quality": typecheck, lint, formatting and unit tests, the same
# checks as `pnpm check`, plus JUnit reports for Jenkins.
# shellcheck source=../lib/common.sh
source "$(dirname "$0")/../lib/common.sh"

# On GitHub Actions, also annotate failing tests in the pull request.
gh_reporter=()
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then gh_reporter=(--reporter=github-actions); fi

info "typecheck"; pnpm typecheck
info "lint"; pnpm lint
info "format check"; pnpm format:check
info "unit tests"
pnpm -r test --reporter=default "${gh_reporter[@]}" --reporter=junit --outputFile.junit=reports/junit-unit.xml
ok "quality checks passed"
