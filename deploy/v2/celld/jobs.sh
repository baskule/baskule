#!/bin/bash
# One-shot jobs of the baskule02 stack (run by docker compose):
#   baskule-celld-job bootstrap   create the fleet bucket on RustFS if missing (SigV4 via curl)
#   baskule-celld-job deploy      `celld deploy` the app with vars generated from the environment, then ask
#                                  every node to adopt it now (POST /reload on the internal listener)
# Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_ENDPOINT, CELLD_BUCKET_NAME, CELLD_BUCKET (s3://name[/prefix])
#      deploy: DEPLOY_APP (auto|platform|hello), CELLD_NODES_INTERNAL ("host:port host:port"), APP vars (see compose).
set -euo pipefail
log() { echo "[baskule-celld-job] $*" >&2; }
sig="aws:amz:${AWS_REGION:-us-east-1}:s3"
# RustFS requires the payload hash header (empty body).
h="x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

wait_s3() {
  for _ in $(seq 120); do curl -s -o /dev/null "$S3_ENDPOINT/" && return 0; sleep 0.5; done
  log "RustFS not reachable at $S3_ENDPOINT"; return 1
}

case "${1:-}" in
  bootstrap)
    wait_s3
    code=$(curl -s -o /dev/null -w '%{http_code}' --aws-sigv4 "$sig" -H "$h" -u "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" -I "$S3_ENDPOINT/$CELLD_BUCKET_NAME")
    if [ "$code" = 200 ]; then log "bucket $CELLD_BUCKET_NAME exists"; exit 0; fi
    curl -sf -o /dev/null --aws-sigv4 "$sig" -H "$h" -u "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" -X PUT "$S3_ENDPOINT/$CELLD_BUCKET_NAME"
    log "bucket $CELLD_BUCKET_NAME created"
    celld diagnose --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" >/dev/null && log "celld diagnose: bucket OK"
    ;;
  deploy)
    app=${DEPLOY_APP:-auto}
    if [ "$app" = auto ]; then
      if [ -f /src/platform/dist/worker.js ] && [ -f /src/platform/wrangler.json ]; then app=platform; else app=hello; fi
    fi
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    cp -r "/src/$app/." "$work/"
    # Resolve {"env":"NAME"} leaves without evaluating shell syntax. Never print the result.
    AUTH_CONFIG=$(jq -ce 'walk(if type == "object" and keys == ["env"] then
      .env as $name | env[$name] | if type == "string" and length > 0 then . else error("Missing authentication environment reference") end
      else . end)' /src/auth.json)
    jq --arg PUBLIC_ORIGINS "${PUBLIC_ORIGINS:-}" --arg AUTH_CONFIG "$AUTH_CONFIG" \
       --arg ADMIN_EMAIL "${ADMIN_EMAIL:-}" --arg ADMIN_PASSWORD "${ADMIN_PASSWORD:-}" --arg ADMIN_NAME "${ADMIN_NAME:-Admin}" \
       --arg AUTH_SECRET "${AUTH_SECRET:-}" --arg COMPUTERD_URL "${COMPUTERD_URL:-}" --arg COMPUTERD_TOKEN "${COMPUTERD_TOKEN:-}" \
       --arg OTLP_TRACES_URL "${OTLP_TRACES_URL:-}" \
       '.vars = ((.vars // {}) + {PUBLIC_ORIGINS:$PUBLIC_ORIGINS, AUTH_CONFIG:$AUTH_CONFIG, ADMIN_EMAIL:$ADMIN_EMAIL,
          ADMIN_PASSWORD:$ADMIN_PASSWORD, ADMIN_NAME:$ADMIN_NAME, AUTH_SECRET:$AUTH_SECRET, COMPUTERD_URL:$COMPUTERD_URL,
          COMPUTERD_TOKEN:$COMPUTERD_TOKEN, OTLP_TRACES_URL:$OTLP_TRACES_URL})' \
       "/src/$app/wrangler.json" > "$work/wrangler.json"
    unset AUTH_CONFIG
    wait_s3
    log "deploying $app"
    celld deploy "$work/wrangler.json" --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT"
    for n in ${CELLD_NODES_INTERNAL:-}; do
      curl -s -m 10 -o /dev/null -X POST "http://$n/reload" && log "reload $n" || log "reload $n failed (it polls every 30 s)"
    done
    log "deployed $app"
    ;;
  *) echo "usage: baskule-celld-job bootstrap|deploy" >&2; exit 2 ;;
esac
