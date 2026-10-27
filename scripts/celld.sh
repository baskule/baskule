#!/usr/bin/env bash
# Shared native celld launcher for local dev/test loops. CELLD_BIN overrides this launcher in callers.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# Celld's asset-cache buckets inherit their first writer's ownership; root and rootless CI must not share them.
export TMPDIR="$ROOT/.run/celld-tmp"
mkdir -p "$TMPDIR"
if [ -x "$ROOT/.tools/bin/celld" ]; then
  exec "$ROOT/.tools/bin/celld" "$@"
fi
if command -v celld >/dev/null 2>&1; then
  exec celld "$@"
fi
echo "Stock celld 0.6.3 is missing. Run $ROOT/scripts/worktree host-init, install celld on PATH, or set CELLD_BIN." >&2
exit 127
