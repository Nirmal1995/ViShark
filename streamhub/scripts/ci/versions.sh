#!/usr/bin/env bash
# Pinned versions of the tools CI needs. One place to bump them.
# Each was chosen at least a week after release (cooldown: most malicious
# releases are caught within days; see the March 2026 Trivy compromise), and
# downloads are checked against these SHA-256 values (from the release's
# published checksums file).
# Used by: scripts/ci/install-tools.sh (GitHub Actions), scripts/ci/toolchain.sh,
# and the Jenkins runbook (docs/operations/jenkins-on-ec2.md).
export CI_NODE_MAJOR=26
export CI_PNPM_VERSION=12.18.0
export CI_GITLEAKS_VERSION=8.30.1
export CI_GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
export CI_TRIVY_VERSION=0.76.1
export CI_TRIVY_SHA256=c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0
export CI_COMPOSE_MIN_MAJOR=2
