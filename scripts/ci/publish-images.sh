#!/usr/bin/env bash
# Run only in the release publish job, after all artifact verification succeeds.
set -euo pipefail
artifacts=${1:?backend artifact directory required}
: "${GH_TOKEN:?}" "${GH_ACTOR:?}"
(cd "$artifacts" && sha256sum -c SHA256SUMS)
shopt -s nullglob
charts=("$artifacts"/baskule-*.tgz)
[[ ${#charts[@]} == 1 ]] || { echo 'Expected exactly one Baskule chart before publication' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"; docker logout ghcr.io >/dev/null 2>&1 || true; helm registry logout ghcr.io >/dev/null 2>&1 || true' EXIT
# Preflight image and chart tags before any publication.
cp "$artifacts/images.txt" "$work/refs"
chart=${charts[0]}
version=${chart##*/baskule-}; version=${version%.tgz}
printf 'ghcr.io/baskule/charts/baskule:%s sha256:%s chart\n' "${version//+/_}" "$(sha256sum "$chart" | cut -d' ' -f1)" >> "$work/refs"
: > "$work/pending"
# Authentication and transport errors fail closed.
while read -r image expected kind; do
  repository=${image%:*}
  repository=${repository#ghcr.io/}
  tag=${image##*:}
  curl --connect-timeout 10 --max-time 30 -fsS --user "$GH_ACTOR:$GH_TOKEN" --get \
    --data-urlencode service=ghcr.io --data-urlencode "scope=repository:$repository:pull,push" \
    https://ghcr.io/token > "$work/token.json"
  token=$(jq -er '.token // .access_token' "$work/token.json")
  status=$(curl --connect-timeout 10 --max-time 30 -sS -o "$work/manifest.json" -w '%{http_code}' \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/$repository/manifests/$tag")
  case "$status" in
    404) printf '%s %s %s\n' "$image" "$expected" "$kind" >> "$work/pending" ;;
    200)
      if [[ $kind == chart ]]; then
        actual=$(jq -er '[.layers[] | select(.mediaType == "application/vnd.cncf.helm.chart.content.v1.tar+gzip")] | if length == 1 then .[0].digest else error("Expected one chart layer") end' "$work/manifest.json")
      else
        # BuildKit can push an index containing the amd64 image plus attestations.
        if jq -e '.manifests' "$work/manifest.json" >/dev/null; then
          digest=$(jq -er '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")] | if length == 1 then .[0].digest else error("Expected one linux/amd64 image") end' "$work/manifest.json")
          curl --connect-timeout 10 --max-time 30 -fsS -H "Authorization: Bearer $token" \
            -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
            "https://ghcr.io/v2/$repository/manifests/$digest" > "$work/manifest.json"
        fi
        actual=$(jq -er '.config.digest' "$work/manifest.json")
      fi
      [[ $actual == "$expected" ]] || { echo "Refusing differing release artifact: $image" >&2; exit 1; }
      echo "Already published matching artifact: $image"
      ;;
    *) echo "Cannot establish whether $image exists (HTTP $status); refusing publication." >&2; exit 1 ;;
  esac
done < "$work/refs"
while read -r image expected kind; do
  [[ $kind != chart ]] || continue
  name=${image%:*}; name=${name##*/}
  docker load -i "$artifacts/$name.tar.gz"
  actual=$(docker save "$image" | bash scripts/ci/image-config-id.sh)
  [[ $actual == "$expected" ]] || { echo "Loaded image differs from verified config: $image" >&2; exit 1; }
done < "$work/pending"
if grep -qv ' chart$' "$work/pending"; then
  printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GH_ACTOR" --password-stdin
  while read -r image _ kind; do
    [[ $kind == chart ]] || docker push "$image"
  done < "$work/pending"
fi
if grep -q ' chart$' "$work/pending"; then
  printf '%s' "$GH_TOKEN" | helm registry login ghcr.io -u "$GH_ACTOR" --password-stdin
  helm push "$chart" oci://ghcr.io/baskule/charts
fi
