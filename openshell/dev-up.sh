#!/usr/bin/env bash
# Development instance of baskule-openshell (for computerd integration tests), independent of the 0.2 stack:
#   container osdev-openshell, network osdev-openshell-net, volumes osdev-openshell-{docker,state}
#   gateway  -> 127.0.0.1:${DEV_GATEWAY_PORT:-47510}   volume helper -> 127.0.0.1:${DEV_VOLUMES_PORT:-47511}
# Token for the volume helper: $OPENSHELL_VOLUMES_TOKEN (default "dev-volumes-token").
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../scripts/env.sh"
SHARED=$BASKULE_SHARED
mkdir -p "$SHARED/run/locks"
exec 9>"$SHARED/run/locks/stack-shared-gateway.lock"
flock -x -w 600 9
C=osdev-openshell
docker network inspect osdev-openshell-net >/dev/null 2>&1 || docker network create osdev-openshell-net >/dev/null
if ! docker container inspect "$C" >/dev/null 2>&1; then
  docker run -d --name "$C" --privileged --network osdev-openshell-net \
    --cpus "${DEV_CPUS:-2}" --memory "${DEV_MEMORY:-6g}" --pids-limit 8192 \
    -p 127.0.0.1:${DEV_GATEWAY_PORT:-47510}:47095 -p 127.0.0.1:${DEV_VOLUMES_PORT:-47511}:47096 \
    -e OPENSHELL_VOLUMES_TOKEN="${OPENSHELL_VOLUMES_TOKEN:-dev-volumes-token}" -e BASKULE_TAG="${BASKULE_TAG:-0.2}" \
    -v osdev-openshell-docker:/var/lib/docker -v osdev-openshell-state:/var/lib/openshell \
    "baskule-openshell-gateway:${BASKULE_TAG:-0.2}" >/dev/null
else
  docker start "$C" >/dev/null
fi
ready() { docker exec "$C" curl -sf -o /dev/null http://127.0.0.1:47097/readyz; }
for _ in $(seq 120); do ready && break; sleep 1; done
ready || { docker logs --tail 50 "$C"; exit 1; }
"$HERE/load-images.sh" "$C"
echo "dev gateway on 127.0.0.1:${DEV_GATEWAY_PORT:-47510}"
