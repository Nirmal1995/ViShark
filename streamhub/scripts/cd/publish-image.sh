#!/usr/bin/env bash
# Deploy step 1: pushes the image CI built and tested to Amazon ECR.
#
#   bash scripts/cd/publish-image.sh <image-archive.tar.gz>
#
# Needs AWS credentials (the deploy role, assumed through OIDC) and
# AWS_REGION, ECR_REPOSITORY. Prints the immutable image reference
# (repository@sha256:digest) as the step output "image-uri": deployments use
# the digest, so the server runs exactly the bytes CI tested.
# Backticks inside single quotes below are Markdown or JMESPath, not shell.
# shellcheck disable=SC2016
# shellcheck source=../lib/common.sh
source "$(dirname "$0")/../lib/common.sh"
require_cmd aws
require_cmd docker

archive="${1:?usage: publish-image.sh <image-archive.tar.gz>}"
: "${AWS_REGION:?AWS_REGION is not set}" "${ECR_REPOSITORY:?ECR_REPOSITORY is not set}"
[ -f "$archive" ] || die "image archive not found: $archive"

local_ref="$(cat "${archive%.tar.gz}.ref")"
tag="${local_ref##*:}"
expected="$(git rev-parse --short=12 HEAD)"
[ "$tag" = "$expected" ] || die "archive holds $local_ref, but this commit is $expected"

info "loading $local_ref"
gunzip -c "$archive" | docker load --quiet

account="$(aws sts get-caller-identity --query Account --output text)"
registry="${account}.dkr.ecr.${AWS_REGION}.amazonaws.com"
repository_uri="${registry}/${ECR_REPOSITORY}"

aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$registry" >/dev/null
trap 'docker logout "$registry" >/dev/null 2>&1 || true' EXIT

# Tags are immutable in ECR. A re-run of the same commit finds its tag already
# there: deploy that image (it was built from this same commit) instead of
# failing on the push.
if digest="$(aws ecr describe-images --repository-name "$ECR_REPOSITORY" \
  --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text 2>/dev/null)"; then
  warn "tag $tag is already in ECR (re-run of this commit); deploying that image"
else
  info "pushing $repository_uri:$tag"
  docker tag "$local_ref" "$repository_uri:$tag"
  docker push --quiet "$repository_uri:$tag"
  digest="$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$repository_uri:$tag" |
    grep "^${repository_uri}@" | head -1 | cut -d@ -f2)"
fi
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "could not determine the image digest"

image_uri="${repository_uri}@${digest}"
ok "image: $image_uri"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "image-uri=$image_uri" >> "$GITHUB_OUTPUT"; fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### Published image\n`%s`\n\nTag `%s`\n' "$image_uri" "$tag" >> "$GITHUB_STEP_SUMMARY"
fi
