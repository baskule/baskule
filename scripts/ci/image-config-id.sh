#!/usr/bin/env bash
# Docker save records the config digest on both classic and containerd stores;
# docker inspect .Id can instead identify a manifest or an index.
set -euo pipefail
config=$(tar -xOf "${1:--}" manifest.json | jq -er 'if length == 1 then .[0].Config else error("Expected one saved image") end')
[[ $config =~ ^(blobs/sha256/)?([a-f0-9]{64})(\.json)?$ ]] || { echo 'Invalid saved image config path' >&2; exit 1; }
printf 'sha256:%s\n' "${BASH_REMATCH[2]}"
