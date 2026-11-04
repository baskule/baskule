#!/usr/bin/env bash
# Assemble operator assets from the same compose definitions used by source builds.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?output directory required}
: "${BASKULE_VERSION:?release version required}"
node "$ROOT/scripts/install-env-docs.mjs" --check
tag=${BASKULE_VERSION//+/_}
mkdir -p "$out"
cp "$ROOT/deploy/docker-compose.yml" "$out/docker-compose.yml"
cp "$ROOT/deploy/.env.example" "$out/baskule.env.example"
# SemVer build metadata uses '_' in Docker tags. Asset defaults always match the published image tags.
for file in "$out"/*.yml "$out"/*.env.example; do
  sed -i "s/BASKULE_VERSION:-[^}]*/BASKULE_VERSION:-$tag/g; s/^BASKULE_VERSION=.*/BASKULE_VERSION=$tag/" "$file"
done
