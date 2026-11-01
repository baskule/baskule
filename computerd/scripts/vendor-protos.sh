#!/usr/bin/env bash
# Refresh the vendored OpenShell protos from the vendored fork (vendor/openshell).
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
FORK=${OPENSHELL_FORK:-$HERE/../vendor/openshell}
cp "$FORK"/proto/{openshell,datamodel,options,sandbox}.proto "$HERE/proto/"
sed -i "1s/source hash [0-9a-f]*/source hash $(python3 "$HERE/../scripts/source-hash.py" "$FORK")/" "$HERE/proto/README.md"
echo "vendored protos from $(python3 "$HERE/../scripts/source-hash.py" "$FORK")"
