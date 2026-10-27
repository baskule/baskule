#!/usr/bin/env bash
# Build the 0.2 images (niced) when no image of their exact sources exists on this Docker host.
#   images.sh            for each image: reuse <name>:src-<hash> if this host ever built those sources, else build
#   images.sh --all      rebuild every image
#   images.sh --missing  only build missing images (what up.sh does)
# <hash> covers the files git would see in the image's source dirs (tracked + untracked, not ignored). Every build is
# also tagged <name>:src-<hash>, so a checkout, branch or revert that returns to the same sources only retags.
# Prints the names of the images whose $TAG now points at another image (one per line).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
MODE=${1:-changed}
export BASKULE_T3_FORK=${BASKULE_T3_FORK:-${T3_APP_DIR:-$ROOT/app}}

src_hash() { # src_hash <dir>...: content hash of the files git would see (tracked + untracked, not ignored)
  local d
  for d in "$@"; do
    if [ -f "$d" ]; then sha256sum "$d" | cut -d' ' -f1; else python3 "$ROOT/scripts/source-hash.py" "$d"; fi
  done | sha256sum | cut -c1-16
}

# image | build command | source dirs (hashed) | extra key
build_one() {
  local img=$1 cmd=$2 extra=$3; shift 3
  local name=${img%%:*} h before
  before=$(docker image inspect -f '{{.Id}}' "$img" 2>/dev/null || true)
  [ "$MODE" = --missing ] && [ -n "$before" ] && return 0
  h=$(printf '%s:%s' "$(src_hash "$@")" "$extra" | sha256sum | cut -c1-16)
  if [ "$MODE" != --all ] && docker image inspect "$name:src-$h" >/dev/null 2>&1; then
    docker tag "$name:src-$h" "$img"
  else
    log "building $img (source $h)"
    eval "$cmd" >&2
    docker tag "$img" "$name:src-$h"
  fi
  [ "$(docker image inspect -f '{{.Id}}' "$img")" = "$before" ] || echo "$img"
}

# The computer carries the fork's shared-browser bridge: its key is that bundle, not the whole fork (a fork change
# outside the bridge used to rebuild the image and recreate every computer). Built from $ROOT so the bundle's path
# comments are the same in every checkout.
mkdir -p "$ROOT/computer/v2/browser"
(cd "$ROOT" && nice -n 10 node "$BASKULE_T3_FORK/apps/server/src/baskule/browser/build.mjs" computer/v2/browser/bridge.mjs)
bridge=$(sha256sum "$ROOT/computer/v2/browser/bridge.mjs" | cut -c1-16)

build_one "baskule-computer:$TAG" '"$ROOT/computer/v2/build.sh" -q >/dev/null' "$bridge" "$ROOT/computer/v2"
toolchain=$(sha256sum "$V2/build-env/Dockerfile" | cut -c1-16)
# The gateway embeds supervisor/sandbox image names, which include TAG.
build_one "baskule-openshell-gateway:$TAG" '"$ROOT/openshell/build.sh"' "$toolchain:$TAG" "$ROOT/openshell" "${OPENSHELL_FORK:-$ROOT/vendor/openshell}"
build_one "baskule-celld:$TAG" 'nice -n 10 docker build --network host -q -t "baskule-celld:$TAG" "$V2/celld" >/dev/null' "" "$V2/celld"
# Hash the shared lock as a whole: platform/e2e dependency changes may also rebuild computerd.
build_one "baskule-computerd:$TAG" 'nice -n 10 docker build --network host -q -t "baskule-computerd:$TAG" -f "$ROOT/computerd/v2/Dockerfile" "$ROOT" >/dev/null' "" "$ROOT/computerd/v2" "$ROOT/package.json" "$ROOT/pnpm-workspace.yaml" "$ROOT/pnpm-lock.yaml"
