#!/usr/bin/env bash
# The embedded-agent component loop, one command (from anywhere):
#   src/agent/test/run.sh [--keep] [--real-llm] [-- run.mjs args]
# 1. dev stack up (devstack.sh: shared OpenShell gateway + computerd v2 + fake LLM + celld dev with the merged SpaceCell);
# 2. the runtime checks (run.mjs);  3. everything stopped and the gateway removed, unless --keep.
# Unit tests are not repeated here: they are part of `pnpm test` (scripts/check fast).
# --real-llm runs the one real-model smoke turn instead of the fake-LLM checks (spend: log it in llm-spend.md).
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd)
P=$(cd "$T/../../.." && pwd)
source "$(cd "$P/.." && pwd)/scripts/env.sh"
KEEP=0 REAL=0 EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in --keep) KEEP=1 ;; --real-llm) REAL=1 ;; --) shift; EXTRA=("$@"); break ;; *) echo "unknown option $1"; exit 2 ;; esac
  shift
done
cleanup() { if [ $KEEP = 1 ]; then "$T/devstack.sh" stop; else "$T/devstack.sh" down; fi; }
trap cleanup EXIT
"$T/devstack.sh" stop >/dev/null
if [ $REAL = 1 ]; then REAL_LLM=1 "$T/devstack.sh" start --clean; node "$T/run.mjs" --real-llm "${EXTRA[@]}"
else "$T/devstack.sh" start --clean; node "$T/run.mjs" "${EXTRA[@]}"; fi
