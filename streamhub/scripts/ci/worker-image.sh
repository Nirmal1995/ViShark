#!/usr/bin/env bash
# CI stage "Worker image": builds the worker image (Node plus FFmpeg), scans
# it, and proves it can actually transcode: a generated clip goes through
# ffprobe and an HLS encode inside the image, and the Node entry point loads.
# shellcheck source=../lib/common.sh
source "$(dirname "$0")/../lib/common.sh"
require_cmd docker
require_cmd trivy

revision="$(git rev-parse --short=12 HEAD)"
image="streamhub-worker:${revision}"
out="reports/security"
mkdir -p "$out"

info "building $image"
docker build --pull -f apps/worker/Dockerfile -t "$image" -t streamhub-worker:ci \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --label "org.opencontainers.image.source=streamhub" \
  .
docker image ls "$image" --format 'size: {{.Size}}'

info "image runs as a non-root user"
uid="$(docker run --rm --entrypoint id "$image" -u)"
[ "$uid" != "0" ] || die "image runs as root"
ok "uid $uid"

info "trivy image: OS packages (FFmpeg included) and Node dependencies"
if trivy image --cache-dir "${TRIVY_CACHE_DIR:-$HOME/.cache/trivy}" --no-progress \
  --severity HIGH,CRITICAL --ignore-unfixed --ignorefile .trivyignore \
  --scanners vuln,secret --format json --output "$out/trivy-worker-image.json" --exit-code 1 "$image"; then
  ok "trivy image: nothing high or critical"
else
  trivy convert --format table "$out/trivy-worker-image.json" || true
  die "trivy image: findings (see $out/trivy-worker-image.json)"
fi

info "smoke test: FFmpeg can make and read HLS inside the image"
docker run --rm --entrypoint sh "$image" -c '
  set -e
  cd /tmp
  ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=640x360:rate=25:duration=2 \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p clip.mp4
  ffprobe -v error -show_entries stream=width,height -of csv=p=0 clip.mp4 | grep -q "^640,360"
  mkdir hls
  ffmpeg -hide_banner -loglevel error -i clip.mp4 -c:v libx264 -preset ultrafast \
    -f hls -hls_time 1 -hls_playlist_type vod -hls_segment_filename hls/seg_%05d.ts hls/index.m3u8
  grep -q EXT-X-ENDLIST hls/index.m3u8
'
ok "ffmpeg and ffprobe work (libx264, HLS muxer)"

info "smoke test: the worker refuses to start without configuration (code loads)"
set +e
logs="$(docker run --rm "$image" 2>&1)"
status=$?
set -e
[ "$status" -ne 0 ] || die "worker started without REDIS_URL"
grep -q 'REDIS_URL' <<<"$logs" || { echo "$logs"; die "expected a configuration error naming REDIS_URL"; }
ok "configuration is validated at startup"
ok "image $image built, scanned and smoke tested"

if [ -n "${IMAGE_ARCHIVE:-}" ]; then
  info "saving $image to $IMAGE_ARCHIVE"
  mkdir -p "$(dirname "$IMAGE_ARCHIVE")"
  docker save "$image" | gzip -1 > "$IMAGE_ARCHIVE"
  echo "$image" > "${IMAGE_ARCHIVE%.tar.gz}.ref"
  ok "archive: $(du -h "$IMAGE_ARCHIVE" | cut -f1)"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Worker image"
    echo "| | |"; echo "|---|---|"
    echo "| Tag | \`$image\` |"
    echo "| Size | $(docker image ls "$image" --format '{{.Size}}') |"
    echo "| Runs as uid | $uid |"
    echo "| Trivy (high, critical) | none |"
  } >> "$GITHUB_STEP_SUMMARY"
fi
