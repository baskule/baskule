#!/usr/bin/env bash
# Run only in the release publish job, after all artifact verification succeeds.
set -euo pipefail
artifacts=${1:?backend artifact directory required}
: "${GH_TOKEN:?}" "${GH_ACTOR:?}"
(cd "$artifacts" && sha256sum -c SHA256SUMS)
work=$(mktemp -d)
trap 'rm -rf "$work"; docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
# Preflight every tag before pushing any image. Authentication and transport errors fail closed.
while read -r image _; do
  repository=${image%:*}
  repository=${repository#ghcr.io/}
  tag=${image##*:}
  curl --connect-timeout 10 --max-time 30 -fsS --user "$GH_ACTOR:$GH_TOKEN" --get \
    --data-urlencode service=ghcr.io --data-urlencode "scope=repository:$repository:pull,push" \
    https://ghcr.io/token > "$work/token.json"
  token=$(jq -er '.token // .access_token' "$work/token.json")
  status=$(curl --connect-timeout 10 --max-time 30 -sS -o /dev/null -w '%{http_code}' --head \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/$repository/manifests/$tag")
  case "$status" in
    404) ;;
    200) echo "Refusing to overwrite existing release image: $image" >&2; exit 1 ;;
    *) echo "Cannot establish whether $image exists (HTTP $status); refusing publication." >&2; exit 1 ;;
  esac
done < "$artifacts/images.txt"
while read -r image _; do
  name=${image%:*}
  name=${name##*/}
  docker load -i "$artifacts/$name.tar.gz"
  docker image inspect "$image" >/dev/null
done < "$artifacts/images.txt"
printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GH_ACTOR" --password-stdin
while read -r image _; do docker push "$image"; done < "$artifacts/images.txt"
