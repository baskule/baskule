#!/bin/bash
# One-shot jobs of the baskule stack (run by docker compose):
#   baskule-celld-job setup       print the admin setup link only while setup is required
#   baskule-celld-job bootstrap   generate consumer secrets, then create the fleet bucket on RustFS if missing (SigV4 via curl)
#   baskule-celld-job deploy      `celld deploy` the app with vars generated from the environment, then ask
#                                  every node to adopt it now (POST /reload on the internal listener)
# Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_ENDPOINT, CELLD_BUCKET_NAME, CELLD_BUCKET (s3://name[/prefix])
#      deploy: CELLD_NODES_INTERNAL ("host:port host:port"), APP vars (see compose).
set -euo pipefail
log() { echo "[baskule-celld-job] $*" >&2; }
secrets_root=${BASKULE_SECRETS_DIR:-/run/baskule}
load_secrets() {
  for role in storage platform; do
    [ ! -f "$secrets_root/$role/secrets" ] || . "$secrets_root/$role/secrets"
  done
  export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-${S3_ACCESS_KEY:-${RUSTFS_ACCESS_KEY:-}}}
  export AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-${S3_SECRET_KEY:-${RUSTFS_SECRET_KEY:-}}}
}
load_secrets

# A key can be shared by consumers, but their mounted volumes expose only their own keys.
ensure_secret() {
  local filename=$1 key=$2 role value= file
  shift 2
  for role in "$@"; do
    file="$secrets_root/$role/$filename"
    if [ -f "$file" ] && grep -q "^export $key=" "$file"; then
      value=$(unset "$key"; . "$file"; printf '%s' "${!key}")
      break
    fi
  done
  [ -n "$value" ] || value=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  for role in "$@"; do
    file="$secrets_root/$role/$filename"
    mkdir -p "$secrets_root/$role"
    chmod 755 "$secrets_root/$role"
    if [ ! -f "$file" ] || ! grep -q "^export $key=" "$file"; then
      printf 'export %s=${%s:-%s}\n' "$key" "$key" "$value" >> "$file"
    fi
    chmod 444 "$file"
  done
}
generate_secrets() {
  local role
  umask 077
  for role in storage platform computerd; do
    mkdir -p "$secrets_root/$role"
    chmod 755 "$secrets_root/$role"
    if [ -f "$secrets_root/$role/secrets" ]; then
      cp "$secrets_root/$role/secrets" "$secrets_root/$role/.pending"
    else
      : > "$secrets_root/$role/.pending"
    fi
  done
  ensure_secret .pending RUSTFS_ACCESS_KEY storage
  ensure_secret .pending RUSTFS_SECRET_KEY storage
  ensure_secret .pending COMPUTERD_TOKEN platform computerd
  ensure_secret .pending SETUP_TOKEN platform
  ensure_secret .pending PLUGIN_SYNC_TOKEN platform
  for role in storage platform computerd; do
    mv "$secrets_root/$role/.pending" "$secrets_root/$role/secrets"
  done
}

print_setup_link() {
  local deadline=$((SECONDS + 90)) status
  while (( SECONDS < deadline )); do
    status=$(curl -fsS --connect-timeout 2 --max-time 10 "$SETUP_STATUS_URL" 2>/dev/null) || status=
    if printf '%s' "$status" | jq -e '(.required | type) == "boolean"' >/dev/null 2>&1; then
      if printf '%s' "$status" | jq -e '.required' >/dev/null; then
        log "Create the first admin: ${PUBLIC_URL:-http://127.0.0.1:47090}/setup#token=$SETUP_TOKEN"
      fi
      return 0
    fi
    (( SECONDS >= deadline )) || sleep 0.5
  done
  log "setup status timed out at $SETUP_STATUS_URL"
  return 1
}
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
    case "${BASKULE_EDGE:-http}" in
      http) ;;
      https)
        [ -n "${BASKULE_DOMAIN:-}" ] || { log "BASKULE_DOMAIN is required when BASKULE_EDGE=https"; exit 1; }
        ;;
      *) log "BASKULE_EDGE must be http or https (lowercase)"; exit 1 ;;
    esac
    print_setup_link
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
    if [ -d /backup/openshell-state ]; then touch /backup/openshell-state/.baskule-restore; fi
    ;;
  bootstrap)
    generate_secrets
    load_secrets
    wait_s3 bucket
    ;;
  deploy)
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    cp -r "/src/platform/." "$work/"
    # Resolve {"env":"NAME"} leaves without evaluating shell syntax. Never print the result.
    auth=${AUTH_CONFIG:-'{"version":1,"mode":"authenticated","password":true}'}
    if [ -f /src/auth.json ]; then auth=$(cat /src/auth.json); fi
    AUTH_CONFIG=$(printf '%s' "$auth" | jq -ce 'walk(if type == "object" and keys == ["env"] then
      .env as $name | env[$name] | if type == "string" and length > 0 then . else error("Missing authentication environment reference") end
      else . end)')
    jq --arg PUBLIC_ORIGINS "${PUBLIC_ORIGINS:-}" --arg AUTH_CONFIG "$AUTH_CONFIG" \
       --arg SETUP_TOKEN "${SETUP_TOKEN:-}" --arg PLUGIN_SYNC_TOKEN "${PLUGIN_SYNC_TOKEN:-}" \
       --arg COMPUTERD_URL "${COMPUTERD_URL:-}" --arg COMPUTERD_TOKEN "${COMPUTERD_TOKEN:-}" \
       --arg OTLP_TRACES_URL "${OTLP_TRACES_URL:-}" \
       '.vars = ((.vars // {}) + {PUBLIC_ORIGINS:$PUBLIC_ORIGINS, AUTH_CONFIG:$AUTH_CONFIG, SETUP_TOKEN:$SETUP_TOKEN, PLUGIN_SYNC_TOKEN:$PLUGIN_SYNC_TOKEN, COMPUTERD_URL:$COMPUTERD_URL,
          COMPUTERD_TOKEN:$COMPUTERD_TOKEN, OTLP_TRACES_URL:$OTLP_TRACES_URL})' \
       "/src/platform/wrangler.json" > "$work/wrangler.json"
    unset AUTH_CONFIG
    wait_s3
    log "deploying platform"
    celld deploy "$work/wrangler.json" --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT"
    for n in ${CELLD_NODES_INTERNAL:-}; do
      curl -s -m 10 -o /dev/null -X POST "http://$n/reload" && log "reload $n" || log "reload $n failed (it polls every 30 s)"
    done
    if [ -n "${PLUGIN_SYNC_TOKEN:-}" ] || [ -e /plugins ]; then
      # A cold Worker may not serve requests immediately after peer reload.
      if [ -n "${PLATFORM_READY_URL:-}" ]; then
        curl -fsS --retry 60 --retry-all-errors --retry-delay 2 --retry-max-time 180 --max-time 5 \
          -o /dev/null "$PLATFORM_READY_URL"
      fi
      /usr/local/bin/baskule-sync-plugins /plugins "${PLUGIN_SYNC_URL:-http://baskule-celld-a:47091}"
    fi
    log "deployed platform"
    ;;
  *) echo "usage: baskule-celld-job setup|run COMMAND|bootstrap|deploy|backup|restore" >&2; exit 2 ;;
esac
