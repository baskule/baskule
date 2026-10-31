#!/usr/bin/env bash
# Build the pinned OpenShell images from the vendored OpenShell fork (vendor/openshell):
#   baskule-openshell-gateway:local     (the baskule-openshell container: private dockerd + gateway + volume helper)
#   baskule-openshell-supervisor:local  (patched supervisor, public_internet egress)
#   baskule-openshell-sandbox:local     (upstream v0.1.5 sandbox runtime, pinned by digest)
# Reuses the compiled binaries in vendor/openshell/target/release. Pass --cargo to rebuild them first
# (niced; OPENSHELL_CARGO_JOBS parallel jobs, default 2: ~60 min cold, 3-5 min incremental; needs libz3, see docs/building.md).
set -euo pipefail
[ "$(. /etc/os-release; echo "$ID:$VERSION_ID")" = ubuntu:24.04 ] && [ "$(uname -m)" = x86_64 ] || {
  echo 'Build OpenShell in deploy/build-env (Ubuntu 24.04 amd64); other native targets need their own environment.' >&2
  exit 1
}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
FORK=${OPENSHELL_FORK:-$ROOT/vendor/openshell}
TAG=${BASKULE_TAG:-local}
BUILD=$HERE/.build
TARGET=${CARGO_TARGET_DIR:?Build in deploy/build-env with a target-specific CARGO_TARGET_DIR}
# If the default buildx activity directory is not writable, use a private CLI config directory.
[ -w "$HOME/.docker/buildx/activity/default" ] 2>/dev/null || export DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.local/baskule/docker-cli}

rev=$(python3 "$ROOT/scripts/source-hash.py" "$FORK")
if [ "${1:-}" = "--cargo" ] || [ "$(cat "$TARGET/baskule-source" 2>/dev/null)" != "$rev" ] || [ ! -x "$TARGET/release/openshell-gateway" ] || [ ! -x "$TARGET/release/openshell-supervisor" ] || [ ! -x "$TARGET/release/openshell" ]; then
  (cd "$FORK" && Z3_LIBRARY_PATH_OVERRIDE=/usr/local/lib nice -n 10 cargo build --release --locked -j"${OPENSHELL_CARGO_JOBS:-2}" -p openshell-supervisor -p openshell-gateway -p openshell-cli)
  echo "$rev" > "$TARGET/baskule-source"
fi

for b in openshell-gateway openshell-supervisor openshell; do
  [ -x "$TARGET/release/$b" ] || { echo "missing $TARGET/release/$b (run with --cargo)" >&2; exit 1; }
done

rm -rf "$BUILD" && mkdir -p "$BUILD"
cp -r "$HERE/images/gateway" "$BUILD/gateway"
cp "$HERE/config/gateway.toml" "$BUILD/gateway/"
cp "$TARGET/release/openshell-gateway" "$TARGET/release/openshell" "$BUILD/gateway/"
cp /usr/local/lib/libz3.so "$BUILD/gateway/"
cp -r "$HERE/images/supervisor" "$BUILD/supervisor"
cp "$TARGET/release/openshell-supervisor" "$BUILD/supervisor/"

label="--label baskule.openshell.fork-rev=$rev"
nice -n 10 docker build --network host -q $label -t "baskule-openshell-supervisor:$TAG" "$BUILD/supervisor"
# The sandbox runtime is compiled from the fork inside the image build (static musl, cached cargo target).
nice -n 10 docker build --network host -q $label --build-arg CARGO_BUILD_JOBS="${OPENSHELL_CARGO_JOBS:-2}" -t "baskule-openshell-sandbox:$TAG" -f "$HERE/images/sandbox/Dockerfile" "$FORK"
# The gateway refuses to start unless the supervisor image is present in its private dockerd: bake the supervisor
# and sandbox runtime images into the gateway image; the entrypoint loads them when their IDs differ.
mkdir -p "$BUILD/gateway/images"
: > "$BUILD/gateway/images/images.txt"
for img in "baskule-openshell-supervisor:$TAG" "baskule-openshell-sandbox:$TAG" "baskule-computer:$TAG"; do
  f=$(echo "$img" | tr ':/' '__').tar
  docker save "$img" | gzip -1 > "$BUILD/gateway/images/$f.gz"
  echo "$f.gz $(docker image inspect --format '{{.Created}}' "$img") $img" >> "$BUILD/gateway/images/images.txt"
done
nice -n 10 docker build --network host -q $label -t "baskule-openshell-gateway:$TAG" "$BUILD/gateway"
rm -rf "$BUILD"
echo "built baskule-openshell-{gateway,supervisor,sandbox}:$TAG from fork $rev"
