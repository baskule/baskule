#!/usr/bin/env bash
# The embedded-agent component loop, one command (from anywhere):
#   src/agent/test/run.sh [--real-llm] [-- run.mjs args]
# 1. dev stack up (devstack.sh: Docker backend + computerd + fake LLM + celld dev with the merged SpaceCell);
# 2. the runtime checks (run.mjs);  3. all harness processes stopped.
# Unit tests are not repeated here: they are part of `pnpm test` (scripts/check fast).
# --real-llm runs one real-model smoke turn (requires REAL_LLM_* configuration; see src/agent/README.md).
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd)
P=$(cd "$T/../../.." && pwd)
source "$(cd "$P/.." && pwd)/scripts/env.sh"
REAL=0 EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in --real-llm) REAL=1 ;; --) shift; EXTRA=("$@"); break ;; *) echo "unknown option $1"; exit 2 ;; esac
  shift
done
cleanup() { "$T/devstack.sh" down; }
trap cleanup EXIT
"$T/devstack.sh" stop >/dev/null
if [ $REAL = 1 ]; then REAL_LLM=1 "$T/devstack.sh" start --clean; node "$T/run.mjs" --real-llm "${EXTRA[@]}"
else "$T/devstack.sh" start --clean; node "$T/run.mjs" "${EXTRA[@]}"; fi
