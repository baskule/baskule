#!/usr/bin/env bash
# One finite build/deploy of the root-owned checkout already authorized by runner/deploy.py.
set -euo pipefail
SRC=/opt/baskule/src
CACHE=/opt/baskule/cache
export HOME=$CACHE/home CARGO_HOME=$CACHE/cargo
toolchain=$(sha256sum "$SRC/deploy/v2/build-env/Dockerfile" | cut -c1-16)
export CARGO_TARGET_DIR=$CACHE/openshell-target-ubuntu24-$toolchain OPENSHELL_CARGO_JOBS=8
mkdir -p "$HOME" "$CARGO_HOME"
cd "$SRC"
# Existing modules use pnpm's default store under the cached HOME; switching stores fails without a TTY.
(cd app && pnpm install --frozen-lockfile --prefer-offline)
pnpm install --frozen-lockfile --prefer-offline
# Tag releases own native packaging. Ordinary main pushes deploy the hosted client and runtime only.
DOWNLOADS=0 STACK_LOCK_OWNER=github-deploy deploy/v2/build.sh
