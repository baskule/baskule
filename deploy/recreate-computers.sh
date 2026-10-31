#!/usr/bin/env bash
# Delete computer sandboxes so the next use recreates them from the current baskule-computer image
# (after a computer image upgrade). The per-space volume (/sandbox/space: home, chats) is KEPT; only the container
# layer (apt-less system dirs, /tmp) is reset. Usage: recreate-computers.sh <spaceId>... | --all | --outdated
set -euo pipefail
. "$(dirname "$0")/lib.sh"
os() { docker exec baskule-openshell openshell --gateway-endpoint http://127.0.0.1:47095 "$@"; }
name_of() { # same mapping as computerd/src/policy.ts namesFor()
  if [[ $1 =~ ^[a-z0-9]([a-z0-9-]{0,14}[a-z0-9])?$ ]]; then echo "os-$1"; else echo "os-$(printf %s "$1" | sha256sum | cut -c1-16)"; fi
}
"$ROOT/openshell/load-images.sh" baskule-openshell
if [ "${1:-}" = --outdated ]; then
  # Compare within the private daemon, where container image IDs and the desired image ID share one store.
  want=$(docker exec baskule-openshell docker image inspect -f '{{.Id}}' "baskule-computer:$TAG")
  ids=$(docker exec baskule-openshell docker ps -aq \
    --filter label=baskule.managed=true --filter label=openshell.ai/isolation-role=sandbox)
  names=
  if [ -n "$ids" ]; then
    names=$(docker exec baskule-openshell docker inspect \
      -f '{{.Image}} {{index .Config.Labels "openshell.ai/sandbox-name"}}' $ids | \
      awk -v want="$want" '$1 != want && $2 ~ /^os-/ {print $2}')
  fi
elif [ "${1:-}" = --all ]; then names=$(os sandbox list 2>/dev/null | awk 'NR > 1 && $1 ~ /^os-/ {print $1}')
else names=$(for s in "$@"; do name_of "$s"; done); fi
[ -n "$names" ] || { log "nothing to recreate"; exit 0; }
for n in $names; do os sandbox delete "$n" >/dev/null && log "deleted $n (volume kept)"; done
