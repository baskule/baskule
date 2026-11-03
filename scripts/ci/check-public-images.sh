#!/usr/bin/env bash
# Rerunnable visibility check, separate from immutable artifact publication.
set -euo pipefail
artifacts=${1:?backend artifact directory required}
shopt -s nullglob
charts=("$artifacts"/baskule-*.tgz)
[[ ${#charts[@]} == 1 ]] || { echo 'Expected exactly one Baskule chart' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$artifacts/images.txt" "$work/refs"
chart=${charts[0]}
version=${chart##*/baskule-}; version=${version%.tgz}
printf 'ghcr.io/baskule/charts/baskule:%s chart\n' "${version//+/_}" >> "$work/refs"
while read -r image _; do
  repository=${image%:*}; repository=${repository#ghcr.io/}; tag=${image##*:}
  curl --connect-timeout 10 --max-time 30 -fsS --get \
    --data-urlencode service=ghcr.io --data-urlencode "scope=repository:$repository:pull" \
    https://ghcr.io/token > "$work/anonymous.json"
  token=$(jq -er '.token // .access_token' "$work/anonymous.json")
  curl --connect-timeout 10 --max-time 30 -fsS --head \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/$repository/manifests/$tag" > /dev/null
done < "$work/refs"
