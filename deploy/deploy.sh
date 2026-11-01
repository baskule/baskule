#!/usr/bin/env bash
# Re-deploy the app to the running fleet (after `cd platform && pnpm run build`, or after changing vars in .env).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
stack_lock_check
dc run --rm --no-deps baskule-deploy
