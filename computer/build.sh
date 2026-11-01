#!/usr/bin/env bash
# Build baskule-computer:local (niced; host network so no docker0 bridge is required).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
[ -w "$HOME/.docker/buildx/activity/default" ] 2>/dev/null || export DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.local/baskule/docker-cli}
# Build the upstream browser service from the selected fork before packaging the computer.
FORK=${BASKULE_T3_FORK:-$HERE/../app}
mkdir -p "$HERE/browser"
# From the repository root, so the bundle (and deploy/images.sh's key of it) is the same in every checkout.
(cd "$HERE/.." && nice -n 10 node "$FORK/apps/server/src/baskule/browser/build.mjs" computer/browser/bridge.mjs)
nice -n 10 docker build --network host -t "baskule-computer:${BASKULE_TAG:-local}" "$@" "$HERE"
