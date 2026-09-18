#!/usr/bin/env bash
#
# Deploy the site: copy site/ into the S3 bucket, then tell CloudFront to
# drop its cached copies so the new version shows up right away.
#
# Usage:            ./scripts/deploy.sh
# Requires:         aws login   (valid AWS session)
#                   terraform apply already ran (the infra exists)

# Safety switches, worth knowing for any shell script:
#   -e  stop at the first failing command (don't barrel on after errors)
#   -u  using an unset variable is an error (catches typos)
#   -o pipefail  a pipeline fails if ANY stage fails, not just the last
set -euo pipefail

# Run from the repository root no matter where the script was called from.
cd "$(dirname "$0")/.."

# Ask Terraform for the real resource names (see infra/outputs.tf) —
# nothing is hardcoded here.
BUCKET="$(terraform -chdir=infra output -raw s3_bucket_name)"
DIST_ID="$(terraform -chdir=infra output -raw cloudfront_distribution_id)"

echo "==> Syncing site/ to s3://${BUCKET}"
# sync uploads new/changed files only; --delete also removes bucket files
# that no longer exist locally, so the bucket mirrors site/ exactly.
aws s3 sync site/ "s3://${BUCKET}" --delete

echo "==> Invalidating CloudFront cache (${DIST_ID})"
# CloudFront edges may hold copies for up to a day; an invalidation tells
# every edge "forget everything" ("/*") so the next request refetches.
# (1,000 invalidation paths/month are free — plenty for a hobby deploy.)
aws cloudfront create-invalidation \
  --distribution-id "${DIST_ID}" \
  --paths "/*" \
  --no-cli-pager

echo "==> Deployed. Site URL:"
terraform -chdir=infra output -raw site_url
echo
