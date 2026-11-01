#!/usr/bin/env bash
# Re-deploy the app to the running fleet (after `cd platform && pnpm run build`, or after changing vars in .env).
# DEPLOY_APP=platform|hello|auto overrides .env.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
stack_lock_check
dc run --rm --no-deps ${DEPLOY_APP:+-e DEPLOY_APP=$DEPLOY_APP} baskule-deploy
