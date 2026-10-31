#!/usr/bin/env bash
# Agent runner dev stack (ports 47650-47699), independent of the live stack:
#   47650  celld dev, harness app (test/harness: the merged SpaceCell with its embedded AgentRuntime + a routing
#          Worker), state in test/.run/app/.celld
#   47651  fake LLM (platform/dev/fake-llm, requires the bearer key "fake-llm-key": proves the key path)
#   47652  computerd from source (computerd/src/main.ts), the real API, IDLE_MINUTES=${IDLE_MINUTES:-3}
#   47510  the shared private OpenShell gateway of the component loops (openshell/dev-up.sh: container
#   47511  osdev-openshell, real baskule-computer:local sandboxes; also used by wpf and computerd)
#
#   ./devstack.sh start [--clean]   build the harness, start everything (the gateway is reused if running)
#   ./devstack.sh restart-celld     restart celld only (persistence checks; same state dir)
#   ./devstack.sh reload            rebuild the harness and restart celld (after a code change)
#   ./devstack.sh stop              stop celld, fake LLM, computerd (the gateway keeps running)
#   ./devstack.sh down [--purge]    stop all, remove the gateway container (--purge: its volumes and network too)
#   REAL_LLM=1 ./devstack.sh start  computerd serves the real key (LLM_ENV_FILE) and the cells use Mistral Large 4
#                                   Spend must be logged.
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd)
P=$(cd "$T/../../.." && pwd)          # platform/
ROOT=$(cd "$P/.." && pwd)
RUN=$T/.run
mkdir -p "$RUN"
source "$ROOT/scripts/env.sh"
CELLD_BIN=${CELLD_BIN:-$ROOT/scripts/celld.sh}
CD_TOKEN=wpd-computerd-token-0123456789
VOL_TOKEN=${OPENSHELL_VOLUMES_TOKEN:-dev-volumes-token}

pidkill() {
  [ -f "$RUN/$1.pid" ] && kill "$(cat "$RUN/$1.pid")" 2>/dev/null || true; rm -f "$RUN/$1.pid"
  case $1 in   # by command line too (setsid may fork, so $! is not always the server's pid)
    celld)
      pkill -f "^$CELLD_BIN dev . --port 47650" || true
      for _ in $(seq 60); do pgrep -f "^$CELLD_BIN .*127.0.0.1:47650" >/dev/null || break; sleep 0.5; done
      pkill -9 -f "^$CELLD_BIN .*47650" || true
      # scripts/celld.sh execs the real binary (resolved path, its own arguments): stop it by its listener too.
      pkill -f -- "celld .*--listen 127.0.0.1:47650" || true ;;
    fake-llm) pkill -f "^node $P/dev/fake-llm/server.mjs --port 47651" || true ;;
  esac
}
wait_http() { for _ in $(seq 1 "${2:-120}"); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done; echo "timeout waiting for $1" >&2; return 1; }

openshell_up() { "$ROOT/openshell/dev-up.sh" >/dev/null; }

build_harness() {
  local out=$RUN/app
  mkdir -p "$out"
  (cd "$P" && BASKULE_ENTRY=src/agent/test/harness/entry.ts BASKULE_OUT="$out" nice -n 10 node scripts/build.mjs)
  local llm_url=http://127.0.0.1:47651/v1 model=fake-model settings='{}'
  if [ "${REAL_LLM:-0}" = 1 ]; then llm_url=https://api.mistral.ai/v1 model=mistral-large-4 settings='{}'; fi
  node -e '
    const [out, url, model, settings, token] = process.argv.slice(1);
    const w = JSON.parse(require("fs").readFileSync(process.argv[6], "utf8"));
    w.main = "worker.js"; delete w.assets;
    const product = JSON.parse(w.vars.TEST_PRODUCT_SETTINGS);
    product.ai.baseUrl = url; product.ai.model.id = model; product.ai.model.settings = JSON.parse(settings);
    if (process.env.REAL_LLM === "1") { product.ai.providerId = "mistral"; product.apiKey = process.env.MISTRAL_API_KEY; }
    Object.assign(w.vars, { TEST_PRODUCT_SETTINGS: JSON.stringify(product), COMPUTERD_TOKEN: token });
    require("fs").writeFileSync(out + "/wrangler.json", JSON.stringify(w, null, 2));
  ' "$out" "$llm_url" "$model" "$settings" "$CD_TOKEN" "$T/harness/wrangler.json"
}

start_celld() {
  export CELLD_ESBUILD=$P/node_modules/.bin/esbuild CELLD_OTEL=0 DO_NOT_TRACK=1 CELLD_FETCH_TIMEOUT_S=3600 CELLD_V8_HEAP_LIMIT_MB=1024
  cd "$RUN/app"; setsid "$CELLD_BIN" dev . --port 47650 --no-watch ${1:-} >> "$RUN/celld.log" 2>&1 < /dev/null & echo $! > "$RUN/celld.pid"; cd "$T"
  wait_http http://127.0.0.1:47650/ 180
}

case "${1:-}" in
  start)
    openshell_up
    if [ "${REAL_LLM:-0}" != 1 ]; then
      FAKE_LLM_KEY=fake-llm-key setsid node "$P/dev/fake-llm/server.mjs" --port 47651 >> "$RUN/fake-llm.log" 2>&1 < /dev/null & echo $! > "$RUN/fake-llm.pid"
    else
      KEY=$(set -a; . "${LLM_ENV_FILE:?Set LLM_ENV_FILE to a private provider env file}"; printf %s "$MISTRAL_API_KEY")
      export MISTRAL_API_KEY="$KEY"
    fi
    env COMPUTERD_INSTANCE=loop-agent COMPUTERD_TOKEN=$CD_TOKEN COMPUTERD_PORT=47652 COMPUTERD_HOST=127.0.0.1 OPENSHELL_GATEWAY=127.0.0.1:${DEV_GATEWAY_PORT:-47510} \
      OPENSHELL_VOLUMES_URL=http://127.0.0.1:${DEV_VOLUMES_PORT:-47511} OPENSHELL_VOLUMES_TOKEN=$VOL_TOKEN IDLE_MINUTES=${IDLE_MINUTES:-3} LOG_LEVEL=info \
      setsid node "$ROOT/computerd/src/main.ts" >> "$RUN/computerd.log" 2>&1 < /dev/null & echo $! > "$RUN/computerd.pid"
    wait_http http://127.0.0.1:47652/healthz 30
    build_harness
    unset KEY MISTRAL_API_KEY
    start_celld "${2:-}"
    echo "agent dev stack up: celld :47650, fake LLM :47651, computerd :47652, OpenShell :${DEV_GATEWAY_PORT:-47510}" ;;
  restart-celld)
    pidkill celld; sleep 1; start_celld; echo "celld restarted" ;;
  reload)
    build_harness; pidkill celld; sleep 1; start_celld; echo "harness rebuilt, celld restarted" ;;
  stop)
    for f in celld fake-llm computerd; do pidkill $f; done; echo "stopped (the OpenShell gateway keeps running)" ;;
  down)
    for f in celld fake-llm computerd; do pidkill $f; done
    "$ROOT/openshell/dev-down.sh" "${2:-}"
    echo "down" ;;
  *) sed -n 2,17p "$0"; exit 2 ;;
esac
