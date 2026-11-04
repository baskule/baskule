#!/usr/bin/env bash
# Stop the stack. Data (volumes) is kept. `--purge` ALSO DELETES ALL DATA (bucket, computers, volumes).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
stack_lock_check
docker rm -f baskule-e2e-llm >/dev/null 2>&1 || true  # the e2e LLM router (e2e/llm) is attached to baskule-net
if [ "${1:-}" = --purge ]; then
  read -r -p "Delete ALL baskule data (bucket, computers)? type 'purge': " a; [ "$a" = purge ] || exit 1
  config=$(dc config --format json)
  instance=$(printf '%s' "$config" | jq -r '.services["baskule-computerd"].environment.COMPUTERD_INSTANCE')
  network=$(printf '%s' "$config" | jq -r '.services["baskule-computerd"].environment.COMPUTER_NETWORK')
  dc down -v --remove-orphans
  docker ps -aq --filter label=baskule.managed=true --filter "label=baskule.instance=$instance" | xargs -r docker rm -f
  docker volume ls -q --filter label=baskule.managed=true --filter "label=baskule.instance=$instance" | xargs -r docker volume rm
  if docker network inspect "$network" >/dev/null 2>&1; then
    docker network rm "$network"
  fi
  docker run --rm --network host --cap-drop ALL --cap-add NET_ADMIN --read-only --tmpfs /run --entrypoint node "$(printf '%s' "$config" | jq -r '.services["baskule-computerd"].image')" --input-type=module -e 'import {guardGcScript} from "./src/guard.ts"; import {execFileSync} from "node:child_process"; execFileSync("sh", ["-ec", guardGcScript()], {stdio:"inherit"});'
  # An external bucket (docs/install.md#external-s3) holds the cells' data outside the volumes: empty it too.
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
