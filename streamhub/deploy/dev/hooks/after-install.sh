#!/usr/bin/env bash
# Prepares the new version WITHOUT touching the running one:
#   1. secrets from SSM Parameter Store -> /etc/streamhub (root only, mode 600)
#   2. pull the images (the API image by digest, from ECR)
#   3. run database migrations (index creation, idempotent)
# If any step fails, the deployment stops here and the old version keeps
# serving. Migrations must therefore stay backward compatible: the old version
# still runs against the migrated database until the new one starts.
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
load_release
region="$(instance_region)"
log "release ${GIT_COMMIT:0:12}, region $region"

# 1. Secrets and account-specific settings. Required: MONGO_URL, SESSION_SECRET,
#    MFA_ENCRYPTION_KEY, REDIS_PASSWORD, S3_BUCKET_UPLOADS (not secret, but it
#    contains the account ID, and the repository is public).
umask 077
mkdir -p "$RUNTIME_DIR"
chmod 0700 "$RUNTIME_DIR"
declare -A params=()
while IFS=$'\t' read -r name value; do
  params["${name#"$PARAMETER_PATH"}"]="$value"
done < <(aws ssm get-parameters-by-path --region "$region" --path "$PARAMETER_PATH" \
  --with-decryption --query 'Parameters[].[Name,Value]' --output text)

secrets_tmp="$(mktemp "$RUNTIME_DIR/secrets.XXXXXX")"
trap 'rm -f "$secrets_tmp"' EXIT
for key in MONGO_URL SESSION_SECRET MFA_ENCRYPTION_KEY REDIS_PASSWORD S3_BUCKET_UPLOADS; do
  value="${params[$key]:-}"
  [ -n "$value" ] || die "SSM parameter ${PARAMETER_PATH}${key} is missing or empty"
  # Values are written single-quoted (taken literally by Compose), so a value
  # must not contain a single quote or a line break.
  [[ "$value" != *"'"* && "$value" != *$'\n'* ]] || die "${key} contains a quote or newline"
  [ "$key" = REDIS_PASSWORD ] && continue
  printf "%s='%s'\n" "$key" "$value" >> "$secrets_tmp"
done
redis_password="${params[REDIS_PASSWORD]}"
[[ "$redis_password" =~ ^[A-Za-z0-9]{32,}$ ]] || die "REDIS_PASSWORD must be at least 32 letters or digits"
printf "REDIS_URL='redis://:%s@redis:6379/0'\n" "$redis_password" >> "$secrets_tmp"
mv "$secrets_tmp" "$RUNTIME_DIR/secrets.env"
trap - EXIT

# Redis reads its password from a config file, not the command line, so it
# never shows up in process listings. uid 999 is the redis user in the image.
cat > "$RUNTIME_DIR/redis.conf" <<CONF
requirepass $redis_password
maxmemory 64mb
maxmemory-policy noeviction
appendonly yes
CONF
chown 999:999 "$RUNTIME_DIR/redis.conf"
chmod 0400 "$RUNTIME_DIR/redis.conf"
log "secrets written to $RUNTIME_DIR (root only)"

# 2. Images.
registry="${API_IMAGE%%/*}"
ecr_login "$registry" "$region"
trap 'docker logout "$registry" >/dev/null 2>&1 || true' EXIT
"${COMPOSE[@]}" pull --quiet
log "images pulled"

# 3. Migrations, with the new image, before it starts serving.
"${COMPOSE[@]}" run --rm --no-deps api node apps/api/dist/cli/migrate.js
log "migrations applied"
