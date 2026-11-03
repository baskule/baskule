#!/usr/bin/env bash
# Package the chart with the vendored dependency; no remote chart repository.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
version=${BASKULE_VERSION:?set the release version}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.+-]+)?$ ]] || { echo 'Expected a SemVer version' >&2; exit 1; }
out=${1:?output directory}
mkdir -p "$out" "$root/.run/helm"
work=$(mktemp -d "$root/.run/helm/package.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp -r "$root/deploy/helm/baskule" "$work/baskule"
# Dependencies are always assembled from the checked-in upstream chart.
rm -rf "$work/baskule/charts"
mkdir -p "$work/baskule/charts"
helm package "$root/vendor/openshell/deploy/helm/openshell" --destination "$work/baskule/charts" >/dev/null
cp "$root/vendor/openshell/LICENSE" "$work/baskule/OPENSHELL-LICENSE"
cp "$root/vendor/openshell/THIRD-PARTY-NOTICES" "$work/baskule/OPENSHELL-THIRD-PARTY-NOTICES"
# The dependency retains its upstream version; select matching Baskule images.
image_tag=${version//+/_}
sed -i "s/tag: \"0.0.0\"/tag: \"$image_tag\"/g" "$work/baskule/values.yaml"
helm lint "$work/baskule" --set s3.endpoint=https://s3.example.test --set s3.bucket=lint --set s3.existingSecret=bucket --set openshell.agentSandbox.preflight.enabled=false
helm package "$work/baskule" --version "$version" --app-version "$image_tag" --destination "$out"
