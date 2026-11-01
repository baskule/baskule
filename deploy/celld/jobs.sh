#!/bin/bash
# One-shot jobs of the baskule stack (run by docker compose):
#   baskule-celld-job setup       generate first-start secrets and print the admin setup link
#   baskule-celld-job bootstrap   create the fleet bucket on RustFS if missing (SigV4 via curl)
#   baskule-celld-job deploy      `celld deploy` the app with vars generated from the environment, then ask
#                                  every node to adopt it now (POST /reload on the internal listener)
# Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_ENDPOINT, CELLD_BUCKET_NAME, CELLD_BUCKET (s3://name[/prefix])
#      deploy: DEPLOY_APP (auto|platform|hello), CELLD_NODES_INTERNAL ("host:port host:port"), APP vars (see compose).
set -euo pipefail
log() { echo "[baskule-celld-job] $*" >&2; }
# Generated defaults preserve explicit container environment values, including optional .env overrides.
if [ -f "${BASKULE_SECRETS_DIR:-/run/baskule}/secrets" ]; then . "${BASKULE_SECRETS_DIR:-/run/baskule}/secrets"; fi
export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-${S3_ACCESS_KEY:-${RUSTFS_ACCESS_KEY:-}}}
export AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-${S3_SECRET_KEY:-${RUSTFS_SECRET_KEY:-}}}
sig="aws:amz:${AWS_REGION:-us-east-1}:s3"
# RustFS requires the payload hash header (empty body).
h="x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

# Keep retries inside one minute, including time spent in curl.
wait_s3() {
  local deadline=$((SECONDS + 60)) remaining code=000 put=none
  while (( SECONDS < deadline )); do
    remaining=$((deadline - SECONDS))
    (( remaining <= 5 )) || remaining=5
    if [ "${1:-}" = bucket ]; then
      code=$(curl -s --connect-timeout 2 --max-time "$remaining" -o /dev/null -w '%{http_code}' \
        --aws-sigv4 "$sig" -H "$h" -u "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
        -I "$S3_ENDPOINT/$CELLD_BUCKET_NAME") || code=000
      if [ "$code" = 200 ]; then log "bucket $CELLD_BUCKET_NAME ready"; return 0; fi
      if (( SECONDS < deadline )); then
        remaining=$((deadline - SECONDS))
        (( remaining <= 5 )) || remaining=5
        put=$(curl -s --connect-timeout 2 --max-time "$remaining" -o /dev/null -w '%{http_code}' \
          --aws-sigv4 "$sig" -H "$h" -u "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
          -X PUT "$S3_ENDPOINT/$CELLD_BUCKET_NAME") || put=000
      fi
    else
      code=$(curl -s --connect-timeout 2 --max-time "$remaining" -o /dev/null -w '%{http_code}' "$S3_ENDPOINT/") || code=000
      # Any HTTP answer means the endpoint is reachable: providers answer unsigned probes with 200, 3xx, 400 or 403.
      [ "$code" = 000 ] || return 0
    fi
    (( SECONDS >= deadline )) || sleep 0.5
  done
  log "S3 readiness timed out at $S3_ENDPOINT (last HTTP status: HEAD/GET=$code PUT=$put)"
  return 1
}

case "${1:-}" in
  setup)
    directory=${BASKULE_SECRETS_DIR:-/run/baskule}
    mkdir -p "$directory"
    if [ ! -f "$directory/secrets" ]; then
      umask 077
      temporary=$(mktemp "$directory/.secrets.XXXXXX")
      trap 'rm -f "$temporary"' EXIT
      for key in RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY COMPUTERD_TOKEN OPENSHELL_VOLUMES_TOKEN SETUP_TOKEN; do
        value=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
        printf 'export %s=${%s:-%s}\n' "$key" "$key" "$value" >> "$temporary"
      done
      # All consumers mount this volume read-only; computerd runs as an unprivileged user.
      chmod 444 "$temporary"
      mv "$temporary" "$directory/secrets"
    fi
    . "$directory/secrets"
    log "Create the first admin: ${PUBLIC_URL:-http://127.0.0.1:47090}/setup#token=$SETUP_TOKEN"
    ;;
  run)
    shift
    exec "$@"
    ;;
  backup)
    # Stop the entire project first. stdout is the archive, never log output.
    tar --xattrs --xattrs-include='*' --numeric-owner -C /backup -cf - . | gzip -1
    ;;
  restore)
    # Restore into empty volumes only; never merge two installations' state.
    for directory in /backup/*; do
      [ -z "$(ls -A "$directory")" ] || { log "restore requires empty volumes"; exit 1; }
    done
    tar --xattrs --xattrs-include='*' --numeric-owner -C /backup -xzf -
    # Restored disks need fresh OpenShell admission records, while their data and keys stay intact.
    touch /backup/openshell-state/.baskule-restore
    ;;
  bootstrap)
    wait_s3 bucket
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
    auth=${AUTH_CONFIG:-'{"version":1,"mode":"authenticated","password":true}'}
    if [ -f /src/config/auth.json ]; then auth=$(cat /src/config/auth.json); fi
    if [ -f /src/auth.json ]; then auth=$(cat /src/auth.json); fi
    AUTH_CONFIG=$(printf '%s' "$auth" | jq -ce 'walk(if type == "object" and keys == ["env"] then
      .env as $name | env[$name] | if type == "string" and length > 0 then . else error("Missing authentication environment reference") end
      else . end)')
    jq --arg PUBLIC_ORIGINS "${PUBLIC_ORIGINS:-}" --arg AUTH_CONFIG "$AUTH_CONFIG" \
       --arg SETUP_TOKEN "${SETUP_TOKEN:-}" \
       --arg AUTH_SECRET "${AUTH_SECRET:-}" --arg COMPUTERD_URL "${COMPUTERD_URL:-}" --arg COMPUTERD_TOKEN "${COMPUTERD_TOKEN:-}" \
       --arg OTLP_TRACES_URL "${OTLP_TRACES_URL:-}" \
       '.vars = ((.vars // {}) + {PUBLIC_ORIGINS:$PUBLIC_ORIGINS, AUTH_CONFIG:$AUTH_CONFIG, SETUP_TOKEN:$SETUP_TOKEN, AUTH_SECRET:$AUTH_SECRET, COMPUTERD_URL:$COMPUTERD_URL,
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
    [ -z "${SETUP_TOKEN:-}" ] || log "Create the first admin: ${PUBLIC_URL:-http://127.0.0.1:47090}/setup#token=$SETUP_TOKEN"
    ;;
  *) echo "usage: baskule-celld-job setup|run COMMAND|bootstrap|deploy|backup|restore" >&2; exit 2 ;;
esac
