#!/usr/bin/env bash
# Installs the pinned security scanners (gitleaks, Trivy) into a directory,
# verifying each download against the SHA-256 in versions.sh. A mismatch stops
# the build: never install a file whose checksum does not match.
#
#   bash scripts/ci/install-tools.sh <install-dir>
#
# Linux x86_64 only (GitHub-hosted runners, the Jenkins host).
# shellcheck source=../lib/common.sh
source "$(dirname "$0")/../lib/common.sh"
# shellcheck source=versions.sh
source "$(dirname "$0")/versions.sh"
require_cmd curl
require_cmd sha256sum

dest="${1:?usage: install-tools.sh <install-dir>}"
mkdir -p "$dest"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() { # url, expected sha256, binary name inside the archive
  local url="$1" sha="$2" bin="$3" file
  file="$work/$(basename "$url")"
  curl -fsSL --retry 3 --retry-delay 2 -o "$file" "$url"
  echo "$sha  $file" | sha256sum --check --quiet || die "checksum mismatch for $(basename "$url")"
  tar -xzf "$file" -C "$work" "$bin"
  install -m 0755 "$work/$bin" "$dest/$bin"
  ok "$bin installed (checksum verified)"
}

fetch "https://github.com/gitleaks/gitleaks/releases/download/v${CI_GITLEAKS_VERSION}/gitleaks_${CI_GITLEAKS_VERSION}_linux_x64.tar.gz" \
  "$CI_GITLEAKS_SHA256" gitleaks
fetch "https://github.com/aquasecurity/trivy/releases/download/v${CI_TRIVY_VERSION}/trivy_${CI_TRIVY_VERSION}_Linux-64bit.tar.gz" \
  "$CI_TRIVY_SHA256" trivy
