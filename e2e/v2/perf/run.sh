#!/usr/bin/env bash
# Cold/warm timings of the live 0.2 stack (see coldwarm.mjs). Restarts both celld nodes once per run.
#   e2e/v2/perf/run.sh <label> [runs=3]        e.g. e2e/v2/perf/run.sh before 5
# Holds the stack lock (deploy/v2/.stack-lock) for its duration; STACK_ROOT names the checkout that runs the stack
# when this one is a worktree (default: this checkout). PERF_WORLD / PERF_EMAIL / PERF_PASSWORD pick the person
# (default: alice of e2e/v2/artifacts/world.json, i.e. the last e2e run).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
. "${STACK_ROOT:-$ROOT}/deploy/v2/lib.sh"
export STACK_LOCK_OWNER=${STACK_LOCK_OWNER:-perf} STACK_LOCK_WAIT=${STACK_LOCK_WAIT:-600}
export PATH="$ROOT/.tools/node-v24.22.1-linux-x64/bin:$PATH"
export PERF_WORLD=${PERF_WORLD:-${STACK_ROOT:-$ROOT}/e2e/v2/artifacts/world.json}
stack_lock_acquire $$ "e2e/v2/perf/run.sh $*" || exit 1
trap stack_lock_release EXIT
node "$HERE/coldwarm.mjs" "${1:-run}" "${2:-3}"
