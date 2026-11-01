#!/usr/bin/env bash
# Back up the data to ./backups/<date>/ (tar.gz of each volume): the bucket (all celld state), the OpenShell
# state (gateway DB, keys) and every computer's /sandbox/space volume (inside the private dockerd).
# Consistency: run it with the stack stopped (./down.sh) for a crash-free copy, or live for a best-effort copy.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
out=${1:-$DEPLOY_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$out"
for v in baskule-rustfs baskule-openshell-state; do
  docker volume inspect "$v" >/dev/null 2>&1 || continue  # no RustFS on a host with an external bucket
  docker run --rm --network none --cap-add SYS_ADMIN --entrypoint sh -v "$v":/v:ro -v "$out":/out baskule-celld:$TAG -c \
    "tar --xattrs --xattrs-include='*' --numeric-owner -C /v -cf - . | gzip -1 > /out/$v.tar.gz"
  log "saved $v"
done
# Space volumes live in the private dockerd: export them through the baskule-openshell container.
if docker inspect baskule-openshell >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Running}}' baskule-openshell)" = true ]; then
  for v in $(docker exec baskule-openshell docker volume ls -q --filter label=baskule.kind=space); do
    docker exec baskule-openshell sh -c "tar --xattrs --xattrs-include='*' --numeric-owner -C /var/lib/docker/volumes/$v/_data -cf - . | gzip -1" > "$out/$v.tar.gz"
    log "saved $v"
  done
else
  docker run --rm --network none --cap-add SYS_ADMIN --entrypoint sh -v baskule-openshell-docker:/d:ro -v "$out":/out baskule-celld:$TAG -c \
    'cd /d/volumes && for v in baskule-space-*; do [ -d "$v/_data" ] && tar --xattrs --xattrs-include="*" --numeric-owner -C "$v/_data" -cf - . | gzip -1 > "/out/$v.tar.gz"; done; true'
  log "saved space volumes (offline)"
fi
log "backup in $out"
