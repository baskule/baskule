#!/usr/bin/env bash
# Copy images from the host daemon into the PRIVATE dockerd of a running baskule-openshell container
# (sandboxes are created there). Only images whose content differs are transferred.
# usage: load-images.sh [container] [image...]
#   default container: baskule-openshell
#   default image: baskule-computer:0.2 (the supervisor and sandbox runtime are baked into the gateway image,
#   whose entrypoint loads them)
set -euo pipefail
C=${1:-baskule-openshell}; shift || true
TAG=${BASKULE_TAG:-0.2}
IMAGES=("$@")
FP='{{.Created}} {{json .RootFS.Layers}}'
[ ${#IMAGES[@]} -gt 0 ] || IMAGES=("baskule-computer:$TAG")
for i in $(seq 60); do docker exec "$C" docker info >/dev/null 2>&1 && break; sleep 1; done
for img in "${IMAGES[@]}"; do
  # Image IDs differ between the host store and the private daemon's containerd store: compare creation time + layers.
  want=$(docker image inspect --format "$FP" "$img")
  have=$(docker exec "$C" docker image inspect --format "$FP" "$img" 2>/dev/null || true)
  if [ "$want" = "$have" ]; then echo "$img: up to date"; continue; fi
  echo "$img: loading into $C ..."
  docker save "$img" | docker exec -i "$C" docker load -q
done
# Drop dangling layers left by replaced tags (inside the private daemon only).
docker exec "$C" docker image prune -f >/dev/null
