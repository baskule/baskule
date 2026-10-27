#!/usr/bin/env bash
# baskule: stops what up.sh started (by recorded PID only). PURGE=1 also deletes the state.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
STATE=${MOCK_STATE_DIR:-$ROOT/.run/wp-e}
for name in mock vite opencode mock-llm; do
  pidfile=$STATE/$name.pid
  [[ -f $pidfile ]] || continue
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    # up.sh starts each service as a process-group leader: stop the whole group.
    kill -- "-$pid" 2>/dev/null || kill "$pid"
    echo "stopped $name ($pid)"
  fi
  rm -f "$pidfile"
done
sleep 1
# The mock stops its T3 servers on SIGTERM; report any listener left on our ports.
ss -H -ltnp 2>/dev/null | grep -E ':477[0-4][0-9] ' || true
[[ ${PURGE:-0} == 1 ]] && rm -rf "$STATE" && echo "purged $STATE"
exit 0
