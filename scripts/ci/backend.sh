#!/usr/bin/env bash
# One build, then isolated consumers of the exact retained archives on hosted runners.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || {
  echo 'The backend CI driver requires a disposable GitHub-hosted runner.' >&2
  exit 1
}
source scripts/env.sh
mkdir -p .run/evidence/release
bundled_images_container=
suite=${1:?build, components, journeys, or install}
shift
cleanup() {
  status=$?
  [[ -z $bundled_images_container ]] || docker rm -v "$bundled_images_container" || true
  if [[ $suite != build ]]; then
    scripts/stack down --purge || true
    openshell/dev-down.sh || true
  fi
  df -h . > .run/evidence/release/disk-final.txt
  docker system df > .run/evidence/release/docker-final.txt || true
  exit "$status"
}
trap cleanup EXIT
if [[ $suite == build ]]; then
  scripts/release-backend.sh 2>&1 | tee .run/evidence/release/backend-build.log
  scripts/ci/artifacts.sh .run/release/backend backend
  exit
fi
(cd .run/release/backend && sha256sum -c SHA256SUMS)
# Every downloaded image must match the ID recorded by the builder. No pull/rebuild.
while read -r image expected; do
  name=${image##*/}; name=${name%%:*}
  docker load -i ".run/release/backend/$name.tar.gz"
  [[ $(docker image inspect --format '{{.Id}}' "$image") == "$expected" ]]
  docker tag "$image" "$name:local"
done < .run/release/backend/images.txt
# The developer harness compares its computer image with the one inside the
# gateway. Recover that exact bundled archive instead of rebuilding the computer.
if [[ $suite != install ]]; then
  bundled_images_container=$(docker create baskule-openshell-gateway:local)
  docker cp "$bundled_images_container:/usr/local/lib/baskule/images/baskule-computer_local.tar.gz" .run/release/computer.tar.gz
  docker rm -v "$bundled_images_container"
  bundled_images_container=
  docker load -i .run/release/computer.tar.gz
  rm .run/release/computer.tar.gz
fi
mkdir -p platform/src/space/t3
tar -xzf .run/release/backend/space-cell.tar.gz -C platform/src/space/t3
export BASKULE_STACK_PROXY=0
case "$suite" in
  components)
    scripts/check "$@" --fresh 2>&1 | tee .run/evidence/release/components.log
    ;;
  journeys|install)
    (cd e2e && pnpm exec playwright install --with-deps chromium)
    if [[ $suite == journeys ]]; then
      scripts/check release:journeys --shard "${1:?N/M}" --fresh 2>&1 | tee .run/evidence/release/journeys.log
    else
      BASKULE_INSTALL_ASSETS="$ROOT/.run/release/backend" BASKULE_INSTALL_VERSION=${BASKULE_VERSION//+/_} \
        node e2e/release-install.mjs "${1:?install target}" 2>&1 | tee .run/evidence/release/install.log
    fi
    ;;
  *) echo "Unknown suite: $suite" >&2; exit 2 ;;
esac
