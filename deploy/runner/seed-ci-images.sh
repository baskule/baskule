#!/usr/bin/env bash
# Root can copy immutable deployment images into CI; the CI account never gets the staging Docker socket.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'run as root' >&2; exit 1; }
uid=$(id -u ghrunner)
ci() { runuser -u ghrunner -- env -i HOME=/srv/ghrunner PATH=/usr/bin:/bin \
  DOCKER_HOST="unix:///run/user/$uid/docker.sock" /usr/bin/docker "$@"; }
source_docker() { /usr/bin/docker --host=unix:///var/run/docker.sock "$@"; }
fingerprint='{{.Created}} {{json .RootFS.Layers}}'
for image in baskule-computer:local baskule-openshell-gateway:local; do
  want=$(source_docker image inspect -f "$fingerprint" "$image")
  have=$(ci image inspect -f "$fingerprint" "$image" 2>/dev/null || true)
  if [ "$have" = "$want" ]; then echo "[ci images] $image unchanged"; continue; fi
  source_docker save "$image" | ci load
  echo "[ci images] copied $image"
done
