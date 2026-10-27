#!/usr/bin/env bash
# Build and exercise exactly the images retained on this disposable runner.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || {
  echo 'The backend CI driver requires a disposable GitHub-hosted runner.' >&2
  exit 1
}
source scripts/env.sh
mkdir -p .run/evidence/release
cleanup() {
  status=$?
  scripts/stack down --purge || true
  openshell/dev-down.sh || true
  df -h . > .run/evidence/release/disk-final.txt
  docker system df > .run/evidence/release/docker-final.txt || true
  exit "$status"
}
trap cleanup EXIT
df -h . | tee .run/evidence/release/disk-before.txt
scripts/release-backend.sh 2>&1 | tee .run/evidence/release/backend-build.log
df -h . | tee .run/evidence/release/disk-built.txt
# Disable the developer's portless HTTPS proxy. Every stack is local, disposable,
# and uses the fake LLM; no deployment environment is loaded.
export BASKULE_STACK_PROXY=0
(cd e2e && pnpm exec playwright install --with-deps chromium)
(cd app/apps/web && pnpm exec playwright install chromium)
scripts/check release upstream --fresh 2>&1 | tee .run/evidence/release/backend-checks.log
scripts/ci/artifacts.sh .run/release/backend backend
