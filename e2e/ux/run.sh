#!/usr/bin/env bash
# Runs the UX journeys (journeys.mjs) on the real stack with the fake LLM, holding the stack lock.
#   e2e/ux/run.sh [journey...]   → e2e/artifacts/ux/<journey>/NN-step.{png,txt}; then hand BRIEF.md to a reviewer.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
. "$ROOT/deploy/lib.sh"
export STACK_LOCK_OWNER=${STACK_LOCK_OWNER:-wp-h-e2e} STACK_LOCK_WAIT=${STACK_LOCK_WAIT:-600}
source "$ROOT/scripts/env.sh"
stack_lock_acquire $$ "e2e/ux/run.sh $*" || exit 1
trap 'stack_lock_release' EXIT
"$ROOT/e2e/llm/llm.sh" router >/dev/null || exit 1
node "$HERE/journeys.mjs" "$@"
