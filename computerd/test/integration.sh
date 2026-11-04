#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/.." && pwd)
source "$ROOT/scripts/env.sh"
export DOCKER_HOST=unix:///var/run/docker.sock
export COMPUTERD_INSTANCE=it-$(openssl rand -hex 8)
export COMPUTER_NETWORK=$COMPUTERD_INSTANCE
export COMPUTERD_TOKEN=$(openssl rand -hex 24)
export COMPUTER_BACKEND=docker COMPUTERD_HOST=127.0.0.1 IDLE_MINUTES=0.25
export COMPUTERD_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
export COMPUTERD_URL=http://127.0.0.1:$COMPUTERD_PORT
EVIDENCE="$ROOT/.run/evidence/docker-int"
mkdir -p "$EVIDENCE"
export COMPUTER_IMAGE=baskule-computer:local
"$ROOT/computer/build.sh" > "$EVIDENCE/build.log" 2>&1
# The guard helper runs from the computerd image (it carries iptables): build it from this checkout.
export COMPUTER_GUARD_IMAGE=baskule-computerd:it
nice -n 10 "$ROOT/scripts/docker-build.sh" computerd --network host -t "$COMPUTER_GUARD_IMAGE" -f "$HERE/Dockerfile" "$ROOT" >> "$EVIDENCE/build.log" 2>&1
PID=
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  docker ps -aq --filter "label=baskule.instance=$COMPUTERD_INSTANCE" | xargs -r docker rm -f
  docker volume ls -q --filter "label=baskule.instance=$COMPUTERD_INSTANCE" | xargs -r docker volume rm
  docker network ls -q --filter "label=baskule.instance=$COMPUTERD_INSTANCE" | xargs -r docker network rm
  docker run --rm --network host --user 0:0 --cap-drop ALL --cap-add NET_ADMIN --read-only --tmpfs /run --entrypoint node "$COMPUTER_GUARD_IMAGE" --input-type=module -e 'import {guardGcScript} from "./src/guard.ts"; import {execFileSync} from "node:child_process"; execFileSync("sh", ["-ec", guardGcScript()], {stdio:"inherit"});'
}
trap cleanup EXIT
node "$HERE/src/main.ts" > "$EVIDENCE/computerd.log" 2>&1 &
PID=$!
node --input-type=module - <<'JS'
import { setTimeout } from 'node:timers/promises';
const deadline = Date.now()+30000;
for (;;) {
  try { if ((await fetch(process.env.COMPUTERD_URL+'/healthz')).ok) break; } catch {}
  if(Date.now()>deadline) throw Error('computerd readiness timeout');
  await setTimeout(100);
}
JS
IDLE_EXPECT_S=90 node --test --test-reporter=spec "$HERE/test/integration.ts" | tee "$EVIDENCE/integration.log"
if [ "${BENCH:-0}" = 1 ]; then
  node "$HERE/test/bench.ts" | tee "$EVIDENCE/bench.jsonl"
fi
