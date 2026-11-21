#!/usr/bin/env bash
# Starts every deployment from an empty release directory, so files deleted
# from deploy/dev in git do not linger on the server. The running containers
# are untouched.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
log "release directory reset"
