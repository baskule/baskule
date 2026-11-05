#!/usr/bin/env bash
# Bring the source stack up: build missing images, start the services, deploy the app. Idempotent. Options: --build (rebuild all images first).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
# Prepare the mounted app before the source deploy job starts.
[ -f "$ROOT/platform/dist/worker.js" ] || "$DEPLOY_DIR/build.sh" --no-deploy
if [ "${1:-}" = --build ]; then "$DEPLOY_DIR/images.sh" --all >/dev/null; else "$DEPLOY_DIR/images.sh" --missing >/dev/null; fi
dc up -d --no-build --remove-orphans
# The deploy job runs once per `up` (when its dependencies are healthy).
for _ in $(seq 300); do
  st=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' baskule-deploy 2>/dev/null || echo "missing 0")
  case "$st" in "exited 0") break ;; "exited "*) docker logs baskule-deploy >&2; log "deploy job failed"; exit 1 ;; esac
  sleep 1
done
docker logs baskule-deploy 2>&1 | tail -3 >&2
wait_healthy baskule-computerd 60
b=$(env_get BASKULE_BIND); p=$(env_get BASKULE_PORT); port=${b:-127.0.0.1}:${p:-47090}
for _ in $(seq 60); do curl -s -o /dev/null "http://$port/" && break; sleep 1; done
log "up: http://$port/"
