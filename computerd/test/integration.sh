#!/usr/bin/env bash
# computerd integration test against the REAL OpenShell gateway (our fork), no LLM.
#   1. starts (or reuses) the dev baskule-openshell container (openshell/dev-up.sh: gateway 127.0.0.1:47510,
#      volume helper 127.0.0.1:47511) and loads baskule-computer:local into it;
#   2. runs computerd from source on 127.0.0.1:47502 with IDLE_MINUTES=0.25;
#   3. runs test/integration.ts (exec, kill, files, CDP, persistence, idle stop);
#   4. deletes the test computer; stops computerd. KEEP_DEV=1 keeps the dev gateway running, otherwise it is removed
#      (volumes kept; `openshell/dev-down.sh --purge` deletes them).
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/.." && pwd)
NODE_BIN=${NODE_BIN:-$(source "$ROOT/scripts/env.sh"; dirname "$(command -v node)")}
export PATH="$ROOT/.tools/bin:$NODE_BIN:$PATH"
node --version | grep -q '^v2[4-9]' || { echo "Node >= 24 required (set NODE_BIN)" >&2; exit 1; }
[ -d "$HERE/node_modules" ] || (cd "$HERE" && pnpm install --frozen-lockfile --prefer-offline)

"$ROOT/openshell/dev-up.sh"
TOKEN=it-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
SPACE=it$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
read -r SANDBOX VOLUME < <(node --input-type=module - "$HERE/src/policy.ts" "$SPACE" <<'JS'
const { namesFor } = await import(process.argv[2]);
const names = namesFor(process.argv[3], "loop-computerd");
console.log(names.sandbox, names.volume);
JS
)
LOG=$(mktemp /tmp/baskule-computerd-it.XXXXXX.log)
COMPUTERD_INSTANCE=loop-computerd COMPUTERD_TOKEN=$TOKEN COMPUTERD_PORT=47502 COMPUTERD_HOST=127.0.0.1 OPENSHELL_GATEWAY=127.0.0.1:${DEV_GATEWAY_PORT:-47510} \
  OPENSHELL_VOLUMES_URL=http://127.0.0.1:${DEV_VOLUMES_PORT:-47511} OPENSHELL_VOLUMES_TOKEN=${OPENSHELL_VOLUMES_TOKEN:-dev-volumes-token} \
  IDLE_MINUTES=0.25 LOG_LEVEL=info node "$HERE/src/main.ts" > "$LOG" 2>&1 &
PID=$!
cleanup() {
  kill $PID 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  docker exec osdev-openshell openshell --gateway-endpoint http://127.0.0.1:47095 sandbox delete "$SANDBOX" >/dev/null 2>&1 || true
  curl -s -X DELETE -H "Authorization: Bearer ${OPENSHELL_VOLUMES_TOKEN:-dev-volumes-token}" "http://127.0.0.1:${DEV_VOLUMES_PORT:-47511}/volumes/$VOLUME" >/dev/null || true
  [ "${KEEP_DEV:-0}" = 1 ] || "$ROOT/openshell/dev-down.sh"
  echo "computerd log: $LOG"
}
trap cleanup EXIT
for _ in $(seq 50); do curl -sf -o /dev/null http://127.0.0.1:47502/healthz && break; sleep 0.2; done
COMPUTERD_URL=http://127.0.0.1:47502 COMPUTERD_TOKEN=$TOKEN SPACE=$SPACE IDLE_EXPECT_S=90 \
  node --test --test-reporter=spec "$HERE/test/integration.ts"
