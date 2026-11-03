#!/usr/bin/env bash
# Package the chart.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
version=${BASKULE_VERSION:?set the release version}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.+-]+)?$ ]] || { echo 'Expected a SemVer version' >&2; exit 1; }
out=${1:?output directory}
mkdir -p "$out" "$root/.run/helm"
work=$(mktemp -d "$root/.run/helm/package.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp -r "$root/deploy/helm/baskule" "$work/baskule"
image_tag=${version//+/_}
sed -i "s/tag: \"0.0.0\"/tag: \"$image_tag\"/g" "$work/baskule/values.yaml"
helm lint "$work/baskule" --set rustfs.enabled=true
helm package "$work/baskule" --version "$version" --app-version "$image_tag" --destination "$out"
