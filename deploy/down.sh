#!/usr/bin/env bash
# Stop the stack. Data (volumes) is kept. `--purge` ALSO DELETES ALL DATA (bucket, computers, volumes).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
stack_lock_check
docker rm -f baskule-e2e-llm >/dev/null 2>&1 || true  # the e2e LLM router (e2e/llm) is attached to baskule-net
if [ "${1:-}" = --purge ]; then
  read -r -p "Delete ALL baskule data (bucket, computers)? type 'purge': " a; [ "$a" = purge ] || exit 1
  dc down -v --remove-orphans
  # An external bucket (dedicated-host.md) holds the cells' data outside the volumes: empty it too.
  if [ -n "$(env_get S3_ENDPOINT)" ]; then
    docker run --rm -e AWS_ACCESS_KEY_ID="$(env_get S3_ACCESS_KEY)" -e AWS_SECRET_ACCESS_KEY="$(env_get S3_SECRET_KEY)" \
      -e AWS_DEFAULT_REGION="$(env_get S3_REGION)" \
      amazon/aws-cli@sha256:c8156a0e74e13929a42d7e60f0d4e14e7d28d980cd21822505d4bff80e5460c1 \
      s3 rm "s3://$(env_get CELLD_BUCKET_NAME)" --recursive --only-show-errors --endpoint-url "$(env_get S3_ENDPOINT)"
    log "bucket $(env_get CELLD_BUCKET_NAME) emptied"
  fi
else
  dc down --remove-orphans
fi
