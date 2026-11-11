#!/usr/bin/env bash
# Integration test on celld dev: real Worker + ControlCell + echo SpaceCell, ports 47620-47629.
#   bash test/integration.sh            (CELLD_BIN to override the celld binary; KEEP=1 keeps state for debugging)
#   bash test/integration.sh --only transcriptions   (only the raw-audio multipart/cap check)
# Builds test/.run/app (bundle of test/integration/entry.ts + the web placeholder),
# starts `celld dev` on :47620 with a fresh state, runs test/integration/run.mjs, restarts celld (persistence check),
# and stops everything.
set -euo pipefail
ONLY=
if [ "$#" -gt 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != --only ] || [ "$2" != transcriptions ]; then
    echo "Usage: test/integration.sh [--only transcriptions]" >&2
    exit 2
  fi
  ONLY=$2
fi
D=$(cd "$(dirname "$0")/.." && pwd)
cd "$D"
CELLD_BIN=${CELLD_BIN:-$D/../scripts/celld.sh}
PORT=${PORT:-47620}
APP=$D/test/.run/app
export CELLD_ESBUILD=${CELLD_ESBUILD:-$D/node_modules/.bin/esbuild} CELLD_OTEL=0 DO_NOT_TRACK=1
rm -rf "$APP" && mkdir -p "$APP"
BASKULE_ENTRY=test/integration/entry.ts BASKULE_OUT=test/.run/app/dist nice -n 10 node scripts/build.mjs
node -e '
  const fs=require("fs"); const w=JSON.parse(fs.readFileSync("wrangler.json","utf8"));
  w.vars.PUBLIC_ORIGINS="http://allowed.test:47090"; w.vars.AUTH_RATE_LIMIT="0";
  w.main="runtime/index.js";
  const app=process.argv[1]; fs.mkdirSync(app+"/backend",{recursive:true});
  fs.renameSync(app+"/dist/runtime",app+"/backend/runtime");
  fs.writeFileSync(app+"/backend/wrangler.json", JSON.stringify(w,null,2));
  const web=JSON.parse(fs.readFileSync("wrangler.web.json","utf8"));
  fs.writeFileSync(app+"/wrangler.web.json",JSON.stringify(web,null,2));' "$APP"
cat > "$APP/backend/.dev.vars" <<VARS
SETUP_TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
VARS

PID=
start() {
  node -e '
    const fs=require("fs"),crypto=require("crypto"),app=process.argv[1];
    const web=JSON.parse(fs.readFileSync(app+"/wrangler.web.json","utf8"));
    web.vars={...web.vars,BASKULE_BACKEND_CONFIG_SHA256:crypto.createHash("sha256").update(fs.readFileSync(app+"/backend/wrangler.json")).update(fs.readFileSync(app+"/backend/.dev.vars")).digest("hex")};
    fs.writeFileSync(app+"/wrangler.web.json",JSON.stringify(web,null,2));' "$APP"
  "$CELLD_BIN" dev "$APP/wrangler.web.json" --service "$APP/backend/wrangler.json" --port "$PORT" --no-watch --logs "$@" >> "$D/test/.run/celld.log" 2>&1 &
  PID=$!
  for i in $(seq 1 120); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && return 0
    kill -0 $PID 2>/dev/null || { tail -30 "$D/test/.run/celld.log"; return 1; }
    sleep 0.5
  done
  echo "celld did not start"; return 1
}
stop() { [ -n "$PID" ] && kill $PID 2>/dev/null && wait $PID 2>/dev/null || true; PID=; }
trap stop EXIT
: > "$D/test/.run/celld.log"
start --clean
if [ -n "$ONLY" ]; then
  SETUP_TOKEN=$(sed -n 's/^SETUP_TOKEN=//p' "$APP/backend/.dev.vars") node test/integration/run.mjs "http://127.0.0.1:$PORT" phase1 --only "$ONLY"
  stop
  [ "${KEEP:-0}" = 1 ] || rm -rf "$APP/.celld"
  echo "integration ($ONLY): OK"
  exit 0
fi
SETUP_TOKEN=$(sed -n 's/^SETUP_TOKEN=//p' "$APP/backend/.dev.vars") node test/integration/run.mjs "http://127.0.0.1:$PORT" phase1
stop
start
SETUP_TOKEN=$(sed -n 's/^SETUP_TOKEN=//p' "$APP/backend/.dev.vars") node test/integration/run.mjs "http://127.0.0.1:$PORT" phase2
stop
node test/integration/oidc.mjs "$APP" "http://127.0.0.1:$PORT" "$CELLD_BIN"
sed -i '/^AUTH_CONFIG=/d' "$APP/backend/.dev.vars"
printf '\nAUTH_CONFIG={"mode":"anonymous"}\n' >> "$APP/backend/.dev.vars"
start --clean
SETUP_TOKEN=$(sed -n 's/^SETUP_TOKEN=//p' "$APP/backend/.dev.vars") node test/integration/run.mjs "http://127.0.0.1:$PORT" anonymous
stop
[ "${KEEP:-0}" = 1 ] || rm -rf "$APP/.celld"
echo "integration: OK"
