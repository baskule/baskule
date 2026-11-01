#!/usr/bin/env bash
# Bring the stack up: build missing images, start OpenShell, load the computer image into its private dockerd,
# start everything else, deploy the app. Idempotent. Options: --build (rebuild all images first).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
[ -f "$DEPLOY_DIR/.env" ] || { log "no .env: run ./init-env.sh (or cp .env.example .env) first"; exit 1; }
if [ "${1:-}" = --build ]; then "$DEPLOY_DIR/images.sh" --all >/dev/null; else "$DEPLOY_DIR/images.sh" --missing >/dev/null; fi
dc up -d --no-build baskule-openshell
wait_healthy baskule-openshell 180
"$ROOT/openshell/load-images.sh" baskule-openshell
dc up -d --no-build
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
