#!/usr/bin/env bash
# Upload a video through the API the way a browser would, then ask for its
# playback URL. A manual end-to-end check for an environment without a web
# app: sign in, create a draft video, multipart-upload the file straight to
# storage with the pre-signed part URLs, complete, then get the signed
# playback URL (admins can preview before publishing).
#
#   scripts/dev/upload-and-play.sh admin@example.com ./clip.mp4
#
# Environment (defaults suit a shell on the dev server):
#   API     http://localhost:4000/api/v1
#   ORIGIN  http://localhost:4000      must be a trusted origin (CSRF check)
#
# The password (and a two-factor code, if enabled) is read with a hidden
# prompt and never appears in the process list, the shell history or a file.
set -euo pipefail

API="${API:-http://localhost:4000/api/v1}"
ORIGIN="${ORIGIN:-http://localhost:4000}"
EMAIL="${1:?usage: $0 <admin-email> <video-file>}"
FILE="${2:?usage: $0 <admin-email> <video-file>}"
[[ -f "$FILE" ]] || { echo "no such file: $FILE" >&2; exit 1; }

case "${FILE,,}" in
  *.mp4 | *.m4v) MIME=video/mp4 ;;
  *.mov) MIME=video/quicktime ;;
  *.webm) MIME=video/webm ;;
  *) echo "unsupported file type (mp4, mov, webm)" >&2; exit 1 ;;
esac
SIZE=$(stat -c %s "$FILE")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
JAR="$WORK/cookies"
CSRF=""

# field <python expression on d> < json
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

api() { # api METHOD PATH [JSON-BODY-ON-STDIN]
  local method=$1 path=$2
  local args=(-sS -X "$method" -c "$JAR" -b "$JAR" -H "Origin: $ORIGIN" -H 'Content-Type: application/json')
  [[ -n "$CSRF" ]] && args+=(-H "X-CSRF-Token: $CSRF")
  [[ "$method" != GET ]] && args+=(--data-binary @-)
  curl "${args[@]}" -w '\n%{http_code}' "$API$path"
}

check() { # check EXPECTED-STATUS RESPONSE  -> prints the body
  local status body
  status=$(tail -n1 <<<"$2")
  body=$(sed '$d' <<<"$2")
  if [[ "$status" != "$1" ]]; then
    echo "expected HTTP $1, got $status: $body" >&2
    exit 1
  fi
  printf '%s' "$body"
}

read -rsp "Password for $EMAIL: " PASSWORD
echo
login=$(printf '%s\n%s' "$EMAIL" "$PASSWORD" |
  python3 -c 'import json,sys; e,p=sys.stdin.read().split("\n",1); print(json.dumps({"email":e,"password":p}))' |
  api POST /auth/login)
unset PASSWORD
body=$(check 200 "$login")
if [[ $(field 'd["data"]["mfaRequired"]' <<<"$body") == True ]]; then
  read -rsp "Two-factor code: " CODE
  echo
  body=$(printf '{"code":"%s"}' "$CODE" | api POST /auth/mfa/verify)
  body=$(check 200 "$body")
fi
CSRF=$(field 'd["data"]["csrfToken"]' <<<"$body")
echo "signed in as $EMAIL"

title="Upload check $(date -u +%Y-%m-%dT%H:%M:%SZ)"
video=$(printf '{"title":"%s"}' "$title" | api POST /videos)
VIDEO_ID=$(check 201 "$video" | field 'd["data"]["id"]')
echo "video $VIDEO_ID created (draft)"

session=$(printf '{"sizeBytes":%s,"mimeType":"%s"}' "$SIZE" "$MIME" | api POST "/admin/videos/$VIDEO_ID/upload")
session=$(check 201 "$session")
PART_SIZE=$(field 'd["data"]["partSizeBytes"]' <<<"$session")
field '"\n".join(str(p["partNumber"]) + " " + p["url"] for p in d["data"]["parts"])' <<<"$session" >"$WORK/parts"
echo "upload started: $(wc -l <"$WORK/parts") part(s) of up to $PART_SIZE bytes"

: >"$WORK/etags"
while read -r number url; do
  dd if="$FILE" of="$WORK/part" bs="$PART_SIZE" skip=$((number - 1)) count=1 status=none
  etag=$(curl -sS -f -X PUT --upload-file "$WORK/part" -D - -o /dev/null "$url" |
    tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
  [[ -n "$etag" ]] || { echo "part $number: no ETag in the response" >&2; exit 1; }
  echo "$number $etag" >>"$WORK/etags"
  echo "  part $number uploaded straight to storage"
done <"$WORK/parts"

parts=$(python3 -c '
import json,sys
print(json.dumps({"parts":[{"partNumber":int(n),"etag":e} for n,e in (l.split(" ",1) for l in open(sys.argv[1]).read().split("\n") if l)]}))' "$WORK/etags")
done_=$(api POST "/admin/videos/$VIDEO_ID/upload/complete" <<<"$parts")
check 200 "$done_" >/dev/null
echo "upload completed and verified (size and file type)"

playback=$(check 200 "$(api GET "/videos/$VIDEO_ID/playback")")
URL=$(field 'd["data"]["url"]' <<<"$playback")
echo "playback (preview=$(field 'd["data"]["preview"]' <<<"$playback"), expires $(field 'd["data"]["expiresAt"]' <<<"$playback"))"

range=$(curl -sS -o /dev/null -D - -H 'Range: bytes=0-1023' "$URL" | tr -d '\r')
echo "range request: $(head -n1 <<<"$range" | cut -d' ' -f2) $(grep -i '^content-range:' <<<"$range" || true)"

echo
echo "Signed URL (open it in a browser to watch; it expires as shown above):"
echo "$URL"
