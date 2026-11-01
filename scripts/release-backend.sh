#!/usr/bin/env bash
# CI backend artifacts only. Deliberately does not source deploy/lib.sh or any deployment environment.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
source scripts/env.sh
if [[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${RUNNER_OS:-} == Linux ]]; then
  # Only the disposable GitHub VM may use its stock rootful daemon. Deployment
  # runners still have to supply their isolated rootless socket below.
  export DOCKER_HOST=unix:///var/run/docker.sock
else
  : "${DOCKER_HOST:?use the isolated rootless CI daemon}"
  [[ $(docker info --format '{{json .SecurityOptions}}') == *name=rootless* ]] || { echo 'release backend requires rootless Docker outside GitHub-hosted VMs' >&2; exit 1; }
fi
[[ $DOCKER_HOST == unix://* ]] || { echo 'release backend requires a local Unix Docker socket' >&2; exit 1; }
: "${BASKULE_VERSION:?set the release version}"
image_tag=${BASKULE_VERSION//+/_}
[[ ${#image_tag} -le 128 && $image_tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || {
  echo 'Release version cannot form a Docker tag.' >&2
  exit 1
}
export BASKULE_TAG=local
mkdir -p .run/release/backend .run/release/runtime
platform/src/space/sync-bundle.sh --minify
(cd platform && BASKULE_MINIFY=1 node scripts/build.mjs)
DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.docker} computer/build.sh
docker build -t baskule-computerd:local -f computerd/Dockerfile .
docker build -t baskule-celld:local deploy/celld
# The existing toolchain supplies Ubuntu, pinned Rust and libz3. Override its staging-only entry point.
toolchain=$(sha256sum deploy/build-env/Dockerfile | cut -c1-16)
target="baskule-ci-native-x86-64-gnu-$toolchain"
docker build --iidfile .run/release/build-env.id deploy/build-env
docker run --rm --init --name "osdev-release-backend-${GITHUB_RUN_ID:-local}" \
  -v "$PWD:$PWD" -w "$PWD" \
  -v "${DOCKER_HOST#unix://}:/var/run/docker.sock" \
  -v "baskule-ci-cargo-$toolchain:/cache/cargo" -v "$target:/cache/target" \
  -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target -e OPENSHELL_CARGO_JOBS=2 \
  -e BASKULE_TAG \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e "GIT_CONFIG_VALUE_0=$PWD" \
  -e DOCKER_HOST=unix:///var/run/docker.sock -e DOCKER_CONFIG=/tmp/docker \
  "$(cat .run/release/build-env.id)" bash openshell/build.sh

# Rust's native target and BuildKit's separate musl target can exceed the entire
# Actions cache quota. Keep them job-local; free them before saving large images.
if [[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]; then
  docker volume rm "$target" "baskule-ci-cargo-$toolchain"
  docker builder prune --all --force
fi

# The Worker is an independent backend asset; hosted web is built in the later apps job.
tar -czf .run/release/backend/platform-worker.tar.gz -C platform/dist worker.js
tar -czf .run/release/backend/space-cell.tar.gz -C platform/src/space/t3 space-cell.js BUILT_FROM
: > .run/release/runtime/images.txt
for image in baskule-computer baskule-computerd baskule-celld baskule-openshell-gateway; do
  docker tag "$image:local" "$image:$image_tag"
  printf '%s %s\n' "$image:$image_tag" "$(docker image inspect --format '{{.Id}}' "$image:$image_tag")" >> .run/release/runtime/images.txt
  # The gateway already embeds the supervisor and sandbox images.
  archive=".run/release/backend/$image.tar.gz"
  docker save "$image:$image_tag" | gzip -1 > "$archive"
  bytes=$(stat -c %s "$archive")
  echo "$archive: $bytes bytes"
  (( bytes < 2147483648 )) || { echo "Release asset exceeds GitHub's 2 GiB limit: $archive" >&2; exit 1; }
done
cp .run/release/runtime/images.txt .run/release/backend/images.txt
