#!/usr/bin/env bash
# Starts (or stops) the SpaceCell test stack by hand, for debugging: fake LLM :47551, fake
# computerd :47552, celld dev on the harness :47550. `./devstack.sh start [--clean]` / `./devstack.sh stop`.
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$D/../../../.." && pwd); RUN=$D/.run; mkdir -p "$RUN"
source "$ROOT/scripts/env.sh"
build_harness() {
  BASKULE_ENTRY=src/space/test/harness/entry.ts BASKULE_OUT="$RUN/app" node "$ROOT/platform/scripts/build.mjs"
  node -e 'const fs = require("node:fs"); const w = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); w.main = "worker.js"; delete w.assets; fs.writeFileSync(process.argv[2], JSON.stringify(w));' "$D/harness/wrangler.json" "$RUN/app/wrangler.json"
}
case "${1:-}" in
  build) build_harness ;;
  start)
    build_harness
    setsid node "$ROOT/platform/dev/fake-llm/server.mjs" --port 47551 >> "$RUN/fake-llm.log" 2>&1 & echo $! > "$RUN/fake-llm.pid"
    setsid node "$D/fake-computerd.mjs" --port 47552 --root "$RUN/computers" >> "$RUN/computerd.log" 2>&1 & echo $! > "$RUN/computerd.pid"
    export CELLD_ESBUILD=${CELLD_ESBUILD:-$ROOT/platform/node_modules/.bin/esbuild} CELLD_OTEL=0 DO_NOT_TRACK=1 CELLD_V8_HEAP_LIMIT_MB=1024 CELLD_FETCH_TIMEOUT_S=3600
    (cd "$RUN/app" && setsid "${CELLD_BIN:-$ROOT/scripts/celld.sh}" dev . --port 47550 --no-watch --logs ${2:-} >> "$RUN/celld.log" 2>&1 & echo $! > "$RUN/celld.pid")
    for _ in $(seq 1 120); do curl -sf -o /dev/null http://127.0.0.1:47550/ && break; sleep 1; done; echo "up" ;;
  stop)
    for f in celld fake-llm computerd; do [ -f "$RUN/$f.pid" ] && kill "$(cat "$RUN/$f.pid")" 2>/dev/null || true; rm -f "$RUN/$f.pid"; done; echo "stopped" ;;
  *) echo "usage: $0 start [--clean] | stop"; exit 2 ;;
esac
