#!/usr/bin/env bash
# baskule: the WP-E feedback loop in one command: Baskule web unit tests, the hosted bundle,
# the mock stack, page checks with screenshots (.run/wp-e/artifacts), then everything stops.
#   SKIP_BUILD=1 ./check.sh       reuse apps/web/dist
#   ./check.sh login admin        only some scenarios
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WEB=$(cd "$HERE/.." && pwd)
ROOT=$(cd "$WEB/../../.." && pwd)   # the umbrella checkout (app/ is vendored in it)
source "$ROOT/scripts/env.sh"
VP=$WEB/../../node_modules/.bin/vp
cd "$WEB"
CI=1 nice -n 10 "$VP" test run --project unit src/baskule || exit 1
if [[ ${SKIP_BUILD:-0} != 1 ]]; then
  VITE_BASKULE_HOSTED=1 nice -n 10 "$VP" build > "$ROOT/.run/wp-e-build.log" 2>&1 || { echo "build failed: $ROOT/.run/wp-e-build.log"; exit 1; }
fi
MOCK_WEB=dist "$HERE/up.sh"
node "$HERE/shots.mjs" "$@"
status=$?
STATE=${MOCK_STATE_DIR:-$ROOT/.run/wp-e}
if [[ $status != 0 ]]; then
  # A failing page check is often the mock itself: show whether it is up and what it last said.
  kill -0 "$(cat "$STATE/mock.pid" 2>/dev/null)" 2>/dev/null && echo "mock: running" || echo "mock: NOT running"
  tail -n 60 "$STATE/logs/mock.log" 2>/dev/null
fi
"$HERE/down.sh"
exit $status
