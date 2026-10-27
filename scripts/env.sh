# Source me: `source baskule/scripts/env.sh`
# Run scripts/worktree setup first: .tools links to the shared pinned Node, pnpm and celld.
BASKULE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/.." && pwd)"
export BASKULE_ROOT
if [[ -z ${BASKULE_SHARED:-} ]]; then
  if [[ -L $BASKULE_ROOT/.tools ]]; then
    BASKULE_SHARED=$(dirname "$(readlink -f "$BASKULE_ROOT/.tools")")
  else
    BASKULE_SHARED=${XDG_CACHE_HOME:-$HOME/.cache}/baskule
  fi
fi
export BASKULE_SHARED
export PATH="$BASKULE_ROOT/.tools/bin:$BASKULE_ROOT/.tools/node-v24.22.1-linux-x64/bin:$PATH"
export pnpm_config_store_dir="${BASKULE_PNPM_STORE:-$BASKULE_SHARED/cache/pnpm-store}"
export npm_config_cache="${npm_config_cache:-$BASKULE_SHARED/cache/npm}"
export T3CODE_TELEMETRY_ENABLED=false
