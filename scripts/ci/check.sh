#!/usr/bin/env bash
# Service-free checks for disposable hosted runners; no evidence refs or model credentials.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
source "$ROOT/scripts/env.sh"
cd "$ROOT"

suite=${1:?Usage: scripts/ci/check.sh <suite> [--dry-run]}
shift
dry=false
while (($#)); do
  case "$1" in
    --dry-run) dry=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
run() {
  printf '+ '; printf '%q ' "$@"; printf '\n'
  if [[ "$dry" == false ]]; then "$@"; fi
}
vp="$ROOT/app/node_modules/.bin/vp"
tc="$ROOT/app/node_modules/.bin/tsc-rs"
test_args=(test run --maxWorkers 4)
case "$suite" in
  harness)
    run node scripts/lint.mjs
    run node scripts/feature-map.mjs
    run node --test scripts/check-lock.test.mjs scripts/check-evidence.test.mjs scripts/celld.test.mjs scripts/lint.test.mjs scripts/stack.test.mjs scripts/feature-map.test.mjs platform/dev/fake-llm/server.test.mjs
    ;;
  platform)
    cd platform
    run pnpm exec vitest run --maxWorkers 4
    ;;
  server)
    cd app/apps/server
    run "$vp" "${test_args[@]}" src/baskule Baskule src/mcp/McpHttpServer.baskule.test.ts
    ;;
  web-unit)
    cd app/apps/web
    run "$vp" "${test_args[@]}" --project unit src/baskule src/branding.test.ts
    ;;
  mobile)
    cd app/apps/mobile
    run "$vp" "${test_args[@]}" --project unit --project react
    ;;
  shared)
    cd app/packages/client-runtime
    run "$vp" "${test_args[@]}"
    cd ../contracts
    run "$vp" "${test_args[@]}" --config ../../vite.config.ts --dir .
    cd ../shared
    run "$vp" "${test_args[@]}" --config ../../vite.config.ts --dir .
    ;;
  desktop)
    run bash desktop/check.sh
    ;;
  type-root)
    run pnpm --dir platform typecheck
    run pnpm --dir computerd/v2 typecheck
    run pnpm --dir computerd/v2 test
    run pnpm --dir e2e typecheck
    ;;
  type-web|type-mobile)
    cd "app/apps/${suite#type-}"
    run "$tc" --noEmit
    ;;
  type-shared)
    for package in client-runtime contracts shared; do
      cd "$ROOT/app/packages/$package"
      run "$tc" --noEmit
    done
    ;;
  *) echo "Unknown suite: $suite" >&2; exit 2 ;;
esac
