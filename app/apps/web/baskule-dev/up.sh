#!/usr/bin/env bash
# baskule: WP-E dev loop. Starts the mock LLM (47702), OpenCode 2 (47703), optionally Vite (47701,
# MOCK_WEB=dev) and the mock Baskule front (47700). State and logs in baskule/.run/wp-e.
#   MOCK_WEB=dist ./up.sh   serve apps/web/dist (build it first with VITE_BASKULE_HOSTED=1)
#   MOCK_WEB=dev  ./up.sh   Vite dev server with HMR behind the mock
#   MOCK_BACKENDS=none      front-only manual checks; scripted sign-in journeys require t3
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WEB=$(cd "$HERE/.." && pwd)
ROOT=$(cd "$WEB/../../.." && pwd)   # the umbrella checkout (app/ is vendored in it)
source "$ROOT/scripts/env.sh"
STATE=${MOCK_STATE_DIR:-$ROOT/.run/wp-e}
mkdir -p "$STATE"/{logs,oc/xdg/config/opencode,oc/xdg/data,oc/xdg/state,oc/xdg/cache,oc/work}
export MOCK_STATE_DIR=$STATE MOCK_WEB=${MOCK_WEB:-dist} MOCK_BACKENDS=${MOCK_BACKENDS:-t3}

start() { # name, command...
  local name=$1; shift
  if [[ -f $STATE/$name.pid ]] && kill -0 "$(cat "$STATE/$name.pid")" 2>/dev/null; then echo "$name already running"; return; fi
  # Own process group, so down.sh also stops the children (Vite, the T3 servers).
  setsid nice -n 10 "$@" > "$STATE/logs/$name.log" 2>&1 &
  echo $! > "$STATE/$name.pid"
  echo "started $name (pid $!)"
}

if [[ $MOCK_BACKENDS == t3 ]]; then
  cat > "$STATE/oc/xdg/config/opencode/opencode.jsonc" <<JSON
{ "model": "llm/m", "share": "disabled", "update": "disable",
  "providers": { "llm": { "name": "llm", "package": "@opencode/ai/providers/openai-compatible", "env": ["MOCK_KEY"],
    "settings": { "baseURL": "http://127.0.0.1:47702/v1" },
    "models": { "m": { "name": "Mock model", "settings": { "reasoningEffort": "none" }, "cost": { "input": 0, "output": 0 }, "limit": { "context": 100000, "output": 4000 } } } } },
  "policies": [{"action":"provider.use","resource":"*","effect":"deny"},{"action":"provider.use","resource":"llm","effect":"allow"}],
  "permissions": [{"action":"*","resource":"*","effect":"allow"}], "plugins": ["-opencode.browser"] }
JSON
  # OpenCode 2 at the protocol version of packages/provider-opencode; a fresh checkout (the CI runner) has none.
  OC=$ROOT/.tools/opencode2
  if [[ $(node -p "require('$OC/node_modules/@opencode/cli/package.json').version" 2>/dev/null) != 2.1.2 ]]; then
    npm install --prefix "$OC" --no-audit --no-fund --prefer-offline @opencode/cli@2.1.2 >/dev/null
  fi
  start mock-llm node "$HERE/mock-llm.mjs"
  (
    export XDG_CONFIG_HOME=$STATE/oc/xdg/config XDG_DATA_HOME=$STATE/oc/xdg/data XDG_STATE_HOME=$STATE/oc/xdg/state \
      XDG_CACHE_HOME=$STATE/oc/xdg/cache OPENCODE_PASSWORD=baskule-mock OPENCODE_DISABLE_CLAUDE_CODE=1 \
      OPENCODE_DISABLE_AUTOUPDATE=1 MOCK_KEY=x HOME=$STATE/oc/work
    cd "$STATE/oc/work"
    start opencode "$ROOT/.tools/opencode2/node_modules/.bin/opencode" serve --hostname 127.0.0.1 --port 47703
  )
fi
if [[ $MOCK_WEB == dev ]]; then
  (cd "$WEB" && VITE_BASKULE_HOSTED=1 PORT=47701 HOST=127.0.0.1 start vite "$WEB/../../node_modules/.bin/vp" dev --port 47701 --strictPort)
fi
start mock node "$HERE/mock-server.mjs"
for _ in $(seq 1 40); do
  if curl -s -o /dev/null http://127.0.0.1:47700/api/baskule/me; then break; fi
  sleep 0.5
done
echo "open http://127.0.0.1:47700  (logs: $STATE/logs)"
