#!/usr/bin/env bash
# Keep ordinary local builds unchanged; release CI exports reusable layers to Actions.
set -euo pipefail
scope=${1:?image cache scope}
shift
if [[ ${BASKULE_DOCKER_CACHE:-0} == 1 ]]; then
  exec docker buildx build --load --allow network.host --cache-from "type=gha,version=2,scope=$scope" \
    --cache-to "type=gha,version=2,scope=$scope,mode=max" "$@"
fi
exec docker build "$@"
