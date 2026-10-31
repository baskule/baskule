#!/usr/bin/env bash
# Switch organization AI settings through the admin API and manage the e2e LLM router.
#   llm.sh router [budgetUsd]   start the router container (fake by default, real on "[[real]]") and update settings
#                               pointing at it. budgetUsd caps the real-model spend of this router's lifetime (0.25).
#   llm.sh restore              restore saved organization settings and remove the router
#   llm.sh usage                print the router's metered real-model usage (JSON)
#   llm.sh status               print the configured organization AI endpoint
# The router keeps its usage in the volume baskule-e2e-llm (reset when the container is recreated with RESET=1).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
. "$ROOT/deploy/lib.sh"
C=baskule-e2e-llm
URL=http://baskule-e2e-llm:47098/v1
case "${1:-}" in
  router)
    source_hash=$(sha256sum "$HERE/router.mjs" "$ROOT/platform/dev/fake-llm/server.mjs" | sha256sum | cut -c1-16)
    mounted_hash=$(docker inspect -f '{{ index .Config.Labels "baskule.e2e.source" }}' "$C" 2>/dev/null || true)
    # A file bind mount can retain the old inode after a git update. Recreate on source changes,
    # preserving the usage volume (RESET=1 remains the explicit budget/ledger reset).
    if [ "${RESET:-0}" = 1 ] || [ "$mounted_hash" != "$source_hash" ]; then
      docker rm -f "$C" >/dev/null 2>&1 || true
      [ "${RESET:-0}" = 1 ] && docker volume rm baskule-e2e-llm >/dev/null 2>&1 || true
      docker run -d --name "$C" --label "baskule.e2e.source=$source_hash" --network baskule-net --network-alias baskule-e2e-llm --restart unless-stopped \
        --cpus 0.5 --memory 256m -e REAL_BUDGET_USD="${2:-0.25}" \
        -v "$HERE/router.mjs:/router/router.mjs:ro" -v "$ROOT/platform/dev/fake-llm/server.mjs:/fake/server.mjs:ro" \
        -v baskule-e2e-llm:/data node:24.22.1-trixie-slim node /router/router.mjs >/dev/null
    else docker start "$C" >/dev/null; fi
    for _ in $(seq 30); do docker exec "$C" node -e 'fetch("http://127.0.0.1:47098/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' && break; sleep 1; done
    node "$HERE/settings.mjs" router "$URL" "${E2E_IDLE_MINUTES:-1.5}"
    log "spaces use the e2e LLM router ($URL)"
    ;;
  restore)
    node "$HERE/settings.mjs" restore
    docker rm -f "$C" >/dev/null 2>&1 || true
    log "restored organization AI and idle settings"
    ;;
  usage) docker exec "$C" node -e 'fetch("http://127.0.0.1:47098/_router/usage").then(r=>r.text()).then(console.log)' ;;
  status) node "$HERE/settings.mjs" status ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
