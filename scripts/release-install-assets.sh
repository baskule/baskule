#!/usr/bin/env bash
# Assemble operator assets from the same compose definitions used by source builds.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?output directory required}
: "${BASKULE_VERSION:?release version required}"
tag=${BASKULE_VERSION//+/_}
mkdir -p "$out"
cp "$ROOT/deploy/docker-compose.yml" "$out/docker-compose.yml"
cp "$ROOT/deploy/.env.example" "$out/baskule.env.example"
for role in node computers edge; do
  cp "$ROOT/deploy/cluster/$role.yml" "$out/cluster-$role.yml"
  cp "$ROOT/deploy/cluster/$role.env.example" "$out/cluster-$role.env.example"
done
# SemVer build metadata uses '_' in Docker tags. Asset defaults always match the published image tags.
for file in "$out"/*.yml "$out"/*.env.example; do
  sed -i "s/BASKULE_VERSION:-0.5.0/BASKULE_VERSION:-$tag/g; s/^BASKULE_VERSION=.*/BASKULE_VERSION=$tag/" "$file"
done
