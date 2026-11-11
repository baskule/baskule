#!/usr/bin/env bash
# CI backend artifacts only. Deliberately does not source deploy/lib.sh or any deployment environment.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
source scripts/env.sh
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted && ${RUNNER_OS:-} == Linux ]] || {
  echo 'release backend requires a disposable GitHub-hosted Linux VM' >&2; exit 1;
}
export DOCKER_HOST=unix:///var/run/docker.sock
: "${BASKULE_VERSION:?set the release version}"
image_tag=${BASKULE_VERSION//+/_}
[[ ${#image_tag} -le 128 && $image_tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || {
  echo 'Release version cannot form a Docker tag.' >&2
  exit 1
}
export BASKULE_TAG=local
mkdir -p .run/release/backend .run/release/runtime
phase=${1:?runtime or package}
save_image() {
  local image=$1 out=$2 archive bytes config_id
  docker tag "$image:local" "ghcr.io/baskule/$image:$image_tag"
  # Retain each runtime image as a separately loadable archive.
  archive="$out/$image.tar.gz"
  docker save "ghcr.io/baskule/$image:$image_tag" | gzip -1 > "$archive"
  config_id=$(bash scripts/ci/image-config-id.sh "$archive")
  printf '%s %s\n' "ghcr.io/baskule/$image:$image_tag" "$config_id" >> "$out/images.txt"
  bytes=$(stat -c %s "$archive")
  echo "$archive: $bytes bytes"
  (( bytes < 2147483648 )) || { echo "Release asset exceeds GitHub's 2 GiB limit: $archive" >&2; exit 1; }
}
case "$phase" in
  runtime)
    DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.docker} computer/build.sh
    scripts/docker-build.sh computerd -t baskule-computerd:local -f computerd/Dockerfile .
    : > .run/release/runtime/images.txt
    for image in baskule-computerd baskule-computer; do
      save_image "$image" .run/release/runtime
    done
    (cd .run/release/runtime && sha256sum *.tar.gz images.txt > SHA256SUMS)
    ;;
  package)
    (cd .run/release/runtime && sha256sum -c SHA256SUMS)
    (cd .run/release/hosted-web && sha256sum -c SHA256SUMS)
    # Use the web bundle already verified by the hosted-web job.
    mkdir -p .run/release/web
    tar -xzf .run/release/hosted-web/hosted-web.tar.gz -C .run/release/web
    platform/src/space/sync-bundle.sh --minify
    (cd platform && BASKULE_MINIFY=1 BASKULE_WEB_DIR="$ROOT/.run/release/web" node scripts/build.mjs)
    jq -n --arg version "$BASKULE_VERSION" --arg umbrella "$(git rev-parse HEAD)" \
      --arg builtAt "$(date -u +%FT%TZ)" '{version:$version,umbrella:$umbrella,builtAt:$builtAt}' > platform/dist/web/version.json
    scripts/docker-build.sh celld -t baskule-celld:local -f deploy/celld/Dockerfile .
    cp .run/release/runtime/*.tar.gz .run/release/runtime/images.txt .run/release/backend/
    save_image baskule-celld .run/release/backend
    tar -czf .run/release/backend/platform-worker.tar.gz -C platform/dist runtime web-worker
    tar -czf .run/release/backend/space-cell.tar.gz -C platform/src/space/t3 space-cell.js BUILT_FROM
    scripts/release-install-assets.sh .run/release/backend
    scripts/helm-package.sh .run/release/backend
    ;;
  *) echo "Unknown backend build phase: $phase" >&2; exit 2 ;;
esac
