#!/usr/bin/env bash
# Builds T3's workerd bundle in the fork and copies it to src/space/t3/space-cell.js (gitignored),
# where SpaceCell imports it. Run before `pnpm run build` whenever the fork changes.
#   T3_APP_DIR   fork checkout with src/baskule/workerd/build.mjs (default: ../app)
#   --minify     minify the bundle, keeping names (deploy/v2/build.sh does; the test runner's --sync does not)
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$D/../../.." && pwd)
APP=${T3_APP_DIR:-$ROOT/app}
[ -f "$APP/apps/server/src/baskule/workerd/build.mjs" ] || { echo "no workerd build in $APP (set T3_APP_DIR)"; exit 1; }
source "$ROOT/scripts/env.sh"
(cd "$APP/apps/server" && nice -n 10 node src/baskule/workerd/build.mjs --out "$D/t3/space-cell.js" "$@")
rm -f "$D/t3/space-cell.js.meta.json"
echo "$(python3 "$ROOT/scripts/source-hash.py" "$APP") $(date -u +%FT%TZ)" > "$D/t3/BUILT_FROM"
