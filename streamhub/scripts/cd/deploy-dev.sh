#!/usr/bin/env bash
# Deploy step 2: packages deploy/dev/ as a CodeDeploy revision, uploads it to
# S3, starts a deployment to the dev server and waits for the result.
#
# Needs AWS credentials (the deploy role) and IMAGE_URI, AWS_REGION,
# DEPLOY_BUCKET, CODEDEPLOY_APPLICATION, CODEDEPLOY_GROUP.
#
# The deployment group rolls back automatically when a deployment fails; this
# script then prints which lifecycle hook failed and the end of its log.
# Backticks inside single quotes below are Markdown or JMESPath, not shell.
# shellcheck disable=SC2016
# shellcheck source=../lib/common.sh
source "$(dirname "$0")/../lib/common.sh"
require_cmd aws
require_cmd zip

: "${IMAGE_URI:?}" "${AWS_REGION:?}" "${DEPLOY_BUCKET:?}" "${CODEDEPLOY_APPLICATION:?}" "${CODEDEPLOY_GROUP:?}"
[[ "$IMAGE_URI" =~ @sha256:[0-9a-f]{64}$ ]] || die "IMAGE_URI must be pinned by digest (repo@sha256:...)"

commit="$(git rev-parse HEAD)"
short="${commit:0:12}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The revision: everything in deploy/dev plus release.env, which pins the
# image this revision runs. Rolling back to an older revision therefore also
# rolls back to its image.
cp -R deploy/dev "$work/bundle"
# CodeDeploy runs hooks directly, so they must be executable. Git may not
# carry the executable bit (core.filemode=false on Windows drives): set it here.
chmod 0755 "$work"/bundle/hooks/*.sh
cat > "$work/bundle/release.env" <<RELEASE
API_IMAGE=$IMAGE_URI
GIT_COMMIT=$commit
RELEASE
(cd "$work/bundle" && zip -qr "$work/revision.zip" .)

key="streamhub-dev/${short}-${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-1}.zip"
info "uploading revision to s3://$DEPLOY_BUCKET/$key"
aws s3 cp "$work/revision.zip" "s3://$DEPLOY_BUCKET/$key" --only-show-errors

deployment_id="$(aws deploy create-deployment \
  --application-name "$CODEDEPLOY_APPLICATION" \
  --deployment-group-name "$CODEDEPLOY_GROUP" \
  --s3-location "bucket=$DEPLOY_BUCKET,key=$key,bundleType=zip" \
  --description "commit $short (run ${GITHUB_RUN_ID:-manual})" \
  --query deploymentId --output text)"
console="https://${AWS_REGION}.console.aws.amazon.com/codesuite/codedeploy/deployments/${deployment_id}?region=${AWS_REGION}"
info "deployment $deployment_id started"
info "console: $console"

summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '### Deployment to dev: %s\n[%s](%s), commit `%s`\n' "$1" "$deployment_id" "$console" "$short" >> "$GITHUB_STEP_SUMMARY"
}

# Polls every 15 seconds; fails as soon as the deployment fails.
if aws deploy wait deployment-successful --deployment-id "$deployment_id"; then
  ok "deployment $deployment_id succeeded"
  summary "succeeded"
  exit 0
fi

fail "deployment $deployment_id did not succeed"
aws deploy get-deployment --deployment-id "$deployment_id" \
  --query 'deploymentInfo.{status:status,error:errorInformation.code,message:errorInformation.message,rollback:rollbackInfo.rollbackMessage}' \
  --output table || true
for instance in $(aws deploy list-deployment-instances --deployment-id "$deployment_id" --query 'instancesList[]' --output text); do
  info "failed lifecycle hooks on $instance:"
  aws deploy get-deployment-instance --deployment-id "$deployment_id" --instance-id "$instance" \
    --query 'instanceSummary.lifecycleEvents[?status==`Failed`].{hook:lifecycleEventName,script:diagnostics.scriptName,error:diagnostics.errorCode,log:diagnostics.logTail}' \
    --output yaml || true
done
summary "failed (rolled back)"
exit 1
