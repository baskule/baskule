#!/usr/bin/env bash
# Agent runner dev stack (ports 47650-47699), independent of the live stack:
#   47650  celld dev, harness app (test/harness: the merged SpaceCell with its embedded AgentRuntime + a routing
#          Worker), state in test/.run/app/.celld
#   47651  fake LLM (platform/dev/fake-llm, requires the bearer key "fake-llm-key": proves the key path)
#   47652  computerd from source (computerd/src/main.ts), the real API, IDLE_MINUTES=${IDLE_MINUTES:-3}
#
#   ./devstack.sh start [--clean]   build the harness, start everything
#   ./devstack.sh restart-celld     restart celld only (persistence checks; same state dir)
#   ./devstack.sh reload            rebuild the harness and restart celld (after a code change)
#   ./devstack.sh stop              stop celld, fake LLM, computerd
#   ./devstack.sh down              stop all processes
#   REAL_LLM=1 ./devstack.sh start  use explicit REAL_LLM_BASE_URL, REAL_LLM_MODEL, REAL_LLM_PROVIDER,
#                                   REAL_LLM_API_KEY. Requires authorization for paid model checks.
#   REAL_LLM_PROVIDER: openai, anthropic, mistral, opencode or custom (BASKULE_AI_PROVIDERS).
set -euo pipefail
# Keep the provider key out of build, computerd and celld child environments.
export -n REAL_LLM_API_KEY
T=$(cd "$(dirname "$0")" && pwd)
P=$(cd "$T/../../.." && pwd)          # platform/
ROOT=$(cd "$P/.." && pwd)
RUN=$T/.run
mkdir -p "$RUN"
source "$ROOT/scripts/env.sh"
CELLD_LAUNCHER=$ROOT/scripts/celld.sh
CELLD_PATTERN=${CELLD_BIN:-$CELLD_LAUNCHER}
CD_TOKEN=dev-computerd-token-0123456789

# Validate paid-provider configuration before starting processes or rebuilding the harness.
if [[ "${REAL_LLM:-0}" = 1 && ( "${1:-}" = start || "${1:-}" = reload ) ]]; then
  for name in REAL_LLM_BASE_URL REAL_LLM_MODEL REAL_LLM_PROVIDER REAL_LLM_API_KEY; do
    if [[ -z "${!name:-}" ]]; then
      echo "REAL_LLM=1 requires $name; set REAL_LLM_BASE_URL, REAL_LLM_MODEL, REAL_LLM_PROVIDER and REAL_LLM_API_KEY explicitly." >&2
      exit 1
    fi
  done
  export REAL_LLM_BASE_URL REAL_LLM_MODEL REAL_LLM_PROVIDER
fi

pidkill() {
  [ -f "$RUN/$1.pid" ] && kill "$(cat "$RUN/$1.pid")" 2>/dev/null || true; rm -f "$RUN/$1.pid"
  case $1 in   # by command line too (setsid may fork, so $! is not always the server's pid)
    celld)
      pkill -f "^$CELLD_PATTERN dev . --port 47650" || true
      for _ in $(seq 60); do pgrep -f "^$CELLD_PATTERN .*127.0.0.1:47650" >/dev/null || break; sleep 0.5; done
      pkill -9 -f "^$CELLD_PATTERN .*47650" || true
      # scripts/celld.sh execs the real binary (resolved path, its own arguments): stop it by its listener too.
      pkill -f -- "celld .*--listen 127.0.0.1:47650" || true ;;
    fake-llm) pkill -f "^node $P/dev/fake-llm/server.mjs --port 47651" || true ;;
  esac
}
wait_http() { for _ in $(seq 1 "${2:-120}"); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done; echo "timeout waiting for $1" >&2; return 1; }


build_harness() {
  local out=$RUN/app
  mkdir -p "$out"
  (cd "$P" && BASKULE_ENTRY=src/agent/test/harness/entry.ts BASKULE_OUT="$out" nice -n 10 node scripts/build.mjs)
  local llm_url=http://127.0.0.1:47651/v1 model=fake-model settings='{}'
  if [ "${REAL_LLM:-0}" = 1 ]; then llm_url=$REAL_LLM_BASE_URL model=$REAL_LLM_MODEL; fi
  REAL_LLM_API_KEY="${REAL_LLM_API_KEY:-}" node -e '
    const [out, url, model, settings, token] = process.argv.slice(1);
    const w = JSON.parse(require("fs").readFileSync(process.argv[6], "utf8"));
    w.main = "runtime/index.js"; w.no_bundle = true; delete w.assets;
    const product = JSON.parse(w.vars.TEST_PRODUCT_SETTINGS);
    product.ai.baseUrl = url; product.ai.model.id = model; product.ai.model.settings = JSON.parse(settings);
    if (process.env.REAL_LLM === "1") { product.ai.providerId = process.env.REAL_LLM_PROVIDER; product.apiKey = process.env.REAL_LLM_API_KEY; }
    Object.assign(w.vars, { TEST_PRODUCT_SETTINGS: JSON.stringify(product), COMPUTERD_TOKEN: token });
    require("fs").writeFileSync(out + "/wrangler.json", JSON.stringify(w, null, 2));
  ' "$out" "$llm_url" "$model" "$settings" "$CD_TOKEN" "$T/harness/wrangler.json"
}

start_celld() {
  export CELLD_ESBUILD=$P/node_modules/.bin/esbuild CELLD_OTEL=0 DO_NOT_TRACK=1 CELLD_FETCH_TIMEOUT_S=3600 CELLD_V8_HEAP_LIMIT_MB=1024
  cd "$RUN/app"; setsid "$CELLD_LAUNCHER" dev . --port 47650 --no-watch ${1:-} >> "$RUN/celld.log" 2>&1 < /dev/null & echo $! > "$RUN/celld.pid"; cd "$T"
  wait_http http://127.0.0.1:47650/ 180
}

case "${1:-}" in
  start)
    if [ "${REAL_LLM:-0}" != 1 ]; then
      FAKE_LLM_KEY=fake-llm-key setsid node "$P/dev/fake-llm/server.mjs" --port 47651 >> "$RUN/fake-llm.log" 2>&1 < /dev/null & echo $! > "$RUN/fake-llm.pid"
    fi
    env COMPUTERD_INSTANCE=loop-agent COMPUTERD_TOKEN=$CD_TOKEN COMPUTERD_PORT=47652 COMPUTERD_HOST=127.0.0.1 COMPUTER_BACKEND=docker COMPUTER_NETWORK=baskule-loop-agent \
      IDLE_MINUTES=${IDLE_MINUTES:-3} LOG_LEVEL=info \
      setsid node "$ROOT/computerd/src/main.ts" >> "$RUN/computerd.log" 2>&1 < /dev/null & echo $! > "$RUN/computerd.pid"
    wait_http http://127.0.0.1:47652/healthz 30
    build_harness
    unset REAL_LLM_API_KEY
    start_celld "${2:-}"
    echo "agent dev stack up: celld :47650, fake LLM :47651, computerd :47652" ;;
  restart-celld)
    pidkill celld; sleep 1; start_celld; echo "celld restarted" ;;
  reload)
    build_harness; pidkill celld; sleep 1; start_celld; echo "harness rebuilt, celld restarted" ;;
  stop)
    for f in celld fake-llm computerd; do pidkill $f; done; echo "stopped" ;;
  down)
    for f in celld fake-llm computerd; do pidkill $f; done
    echo "down" ;;
  *) sed -n 2,14p "$0"; exit 2 ;;
esac
