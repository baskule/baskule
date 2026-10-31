#!/usr/bin/env bash
# One command that builds the whole stack from source and deploys it on the running (or started) stack:
#   1. the hosted web bundle        T3 fork worktree, apps/web, VITE_BASKULE_HOSTED=1   (skipped if the fork is unchanged)
#   2. the T3 space-cell bundle     platform/src/space/sync-bundle.sh --minify, T3_APP_DIR  (skipped if the fork is unchanged)
#   3. the platform bundle          platform/: scripts/build.mjs, minified (worker + web + downloads) + dist/web/version.json
#   4. the images                   images.sh: computer, openshell, celld, computerd when their sources changed
#   5. desktop artifacts            desktop/release/*.AppImage, *.tar.gz, *.apk → /downloads/ (if present; DOWNLOADS=0 skips)
#   6. up.sh (start what is not running) + deploy.sh (celld deploy of platform/, nodes reload)
#
# Usage: deploy/build.sh [--no-deploy] [--force]
#   T3_APP_DIR   fork checkout to build (default: <root>/app)
#   --force      rebuild the web and space bundles even if the fork did not change
#   --no-deploy  build only
#   DOWNLOADS=0  do not publish desktop artifacts (faster deploys: they are ~200 MB of assets)
#   MINIFY=0     unminified space and platform bundles (debugging; default 1: minified, names kept)
# AI and organization settings are configured in the app; authentication comes from auth.json.
# Version: GET /version.json on the stack (umbrella and fork SHAs, dirty flags, build time, image ids).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
DEPLOY=1; FORCE=0
for a in "$@"; do case $a in --no-deploy) DEPLOY=0 ;; --force) FORCE=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done
APP=${T3_APP_DIR:-$ROOT/app}
PLATFORM=$ROOT/platform
STAMPS=$ROOT/.run/build
mkdir -p "$STAMPS"
source "$ROOT/scripts/env.sh"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
[ -f "$APP/apps/web/package.json" ] || { log "no T3 fork checkout at $APP (set T3_APP_DIR)"; exit 1; }
t_all=$(date +%s)
step() { log "[$(($(date +%s) - t_all))s] $*"; }

# Identity of a git checkout's content: HEAD + uncommitted changes (diff and untracked files).
tree_key() { python3 "$ROOT/scripts/source-hash.py" "$1"; }
desc() { local s; s=$(git -C "$1" rev-parse --short=10 HEAD); [ -n "$(git -C "$1" status --porcelain -uno 2>/dev/null)" ] && s="$s-dirty"; echo "$s"; }
fork_key=$(tree_key "$APP")
export BASKULE_T3_FORK="$APP"

# ---------------------------------------------------------------------------------------------- 1. web bundle
if [ ! -f "$APP/node_modules/.modules.yaml" ]; then
  step "installing the fork's dependencies"
  (cd "$APP" && nice -n 10 pnpm install --frozen-lockfile --prefer-offline >/dev/null)
fi
if [ $FORCE = 1 ] || [ "$(cat "$STAMPS/web.key" 2>/dev/null)" != "$fork_key" ] || [ ! -f "$APP/apps/web/dist/index.html" ]; then
  step "web bundle (hosted) from $APP"
  (cd "$APP/apps/web" && VITE_BASKULE_HOSTED=1 nice -n 10 "$APP/node_modules/.bin/vp" build >"$STAMPS/web-build.log" 2>&1) ||
    { tail -30 "$STAMPS/web-build.log" >&2; log "web build failed: $STAMPS/web-build.log"; exit 1; }
  echo "$fork_key" >"$STAMPS/web.key"
else step "web bundle unchanged"; fi

# ---------------------------------------------------------------------------------------------- 2. space-cell bundle
MINIFY=${MINIFY:-1}
space_key="$fork_key minify=$MINIFY"
if [ $FORCE = 1 ] || [ "$(cat "$STAMPS/space.key" 2>/dev/null)" != "$space_key" ] || [ ! -f "$PLATFORM/src/space/t3/space-cell.js" ]; then
  step "T3 space-cell bundle"
  T3_APP_DIR=$APP "$PLATFORM/src/space/sync-bundle.sh" $([ "$MINIFY" = 1 ] && echo --minify) >"$STAMPS/space-build.log" 2>&1 ||
    { tail -30 "$STAMPS/space-build.log" >&2; log "space bundle failed: $STAMPS/space-build.log"; exit 1; }
  echo "$space_key" >"$STAMPS/space.key"
else step "space-cell bundle unchanged"; fi

# ---------------------------------------------------------------------------------------------- 5. downloads (staged first)
DL=$STAMPS/downloads
rm -rf "$DL"; mkdir -p "$DL"
if [ "${DOWNLOADS:-1}" = 1 ]; then
  ARTIFACT_DIR=${BASKULE_ARTIFACT_DIR:-$ROOT/desktop/release}
  for f in "$ARTIFACT_DIR"/*.AppImage "$ARTIFACT_DIR"/*.tar.gz "$ARTIFACT_DIR"/*.apk; do
    [ -f "$f" ] || continue
    ln -f "$f" "$DL/" 2>/dev/null || cp "$f" "$DL/"
  done
fi
step "downloads: $(ls "$DL" | wc -l) file(s)"

# ---------------------------------------------------------------------------------------------- 3. platform bundle
[ -d "$PLATFORM/node_modules" ] || (cd "$ROOT" && nice -n 10 pnpm install --frozen-lockfile --prefer-offline >/dev/null)
step "platform bundle"
(cd "$PLATFORM" && BASKULE_MINIFY=$MINIFY BASKULE_WEB_DIR="$APP/apps/web/dist" BASKULE_DOWNLOADS_DIR="$DL" nice -n 10 node scripts/build.mjs 2>&1 | tail -3 >&2)

# ---------------------------------------------------------------------------------------------- 4. images
step "images"
rebuilt=$("$DEPLOY_DIR/images.sh")
[ -n "$rebuilt" ] && step "rebuilt: $(echo $rebuilt)"

# Version stamp, served as a static file by the Worker.
img_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null | cut -c8-19; }
jq -n --arg umbrella "$(desc "$ROOT")" --arg fork "$fork_key" --arg forkBranch "$(git -C "$APP" rev-parse --abbrev-ref HEAD)" \
  --arg spaceBundle "$(cat "$PLATFORM/src/space/t3/BUILT_FROM" 2>/dev/null | cut -d' ' -f1)" \
  --arg builtAt "$(date -u +%FT%TZ)" --arg computer "$(img_id "baskule-computer:$TAG")" \
  --arg computerd "$(img_id "baskule-computerd:$TAG")" --arg celld "$(img_id "baskule-celld:$TAG")" \
  --arg openshell "$(img_id "baskule-openshell-gateway:$TAG")" \
  '{umbrella:$umbrella, fork:$fork, forkBranch:$forkBranch, spaceBundle:$spaceBundle, builtAt:$builtAt,
    images:{computer:$computer, computerd:$computerd, celld:$celld, openshell:$openshell}}' >"$PLATFORM/dist/web/version.json"
step "version: $(jq -c '{umbrella, fork}' "$PLATFORM/dist/web/version.json")"

[ $DEPLOY = 1 ] || { step "built (no deploy)"; exit 0; }

# ---------------------------------------------------------------------------------------------- 6. up + deploy
stack_lock_check
was_up=0
[ "$(docker inspect -f '{{.State.Running}}' baskule-celld-a 2>/dev/null)" = true ] && was_up=1
if [ $was_up = 1 ]; then
  # Running stack: recreate only services whose image changed (compose compares image ids), then deploy once.
  step "refresh running services"
  dc up -d --no-build baskule-openshell baskule-traces baskule-edge baskule-computerd baskule-celld-a baskule-celld-b >&2
  wait_healthy baskule-openshell 180
  "$ROOT/openshell/load-images.sh" baskule-openshell >&2
  step "deploy.sh"
  "$DEPLOY_DIR/deploy.sh" 2>&1 | tail -2 >&2
else
  step "up.sh"
  "$DEPLOY_DIR/up.sh"
fi
# Reconcile actual workloads: a previous build or interrupted deployment may already have retagged the host image.
step "reconcile computer images"
"$DEPLOY_DIR/recreate-computers.sh" --outdated
b=$(env_get BASKULE_BIND); p=$(env_get BASKULE_PORT); url=http://${b:-127.0.0.1}:${p:-47090}
for _ in $(seq 60); do
  v=$(curl -s -m 5 "$url/version.json" | jq -r .builtAt 2>/dev/null || true)
  [ "$v" = "$(jq -r .builtAt "$PLATFORM/dist/web/version.json")" ] && break
  sleep 2
done
[ "$v" = "$(jq -r .builtAt "$PLATFORM/dist/web/version.json")" ] && step "deployed: $url/version.json = $(curl -s "$url/version.json" | jq -c '{umbrella, fork, builtAt}')" ||
  { log "the stack does not serve the new version.json yet (got builtAt=$v)"; exit 1; }
