#!/bin/bash
set -euo pipefail
: "${COMPUTERD_INSTANCE:?installation identity required}"
: "${BACKUP_IMAGE:?helper image required}"
api() { curl --silent --show-error --fail --unix-socket /var/run/docker.sock "$@"; }
url=http://localhost
legacy=${COMPUTER_LEGACY_VOLUME:-}
stage=$(mktemp -d)
helper=
cleanup() {
  if [ -n "$helper" ]; then api -X DELETE "$url/containers/$helper" >/dev/null; fi
  rm -rf "$stage"
}
trap cleanup EXIT
mount_disk() {
  local name=$1 readonly=$2
  helper=$(api -H 'Content-Type: application/json' -d "$(jq -n --arg name "$name" --arg image "$BACKUP_IMAGE" --argjson ro "$readonly" '{Image:$image,HostConfig:{NetworkMode:"none",Mounts:[{Type:"volume",Source:$name,Target:"/disk",ReadOnly:$ro,VolumeOptions:{NoCopy:true}}]}}')" "$url/containers/create" | jq -er .Id)
}
unmount_disk() { api -X DELETE "$url/containers/$helper" >/dev/null; helper=; }
case "$1" in
backup)
  mkdir "$stage/disks"
  filters=$(jq -nc --arg instance "$COMPUTERD_INSTANCE" '{label:["baskule.managed=true",("baskule.instance="+$instance)]}')
  api -G --data-urlencode "filters=$filters" "$url/volumes" | jq '[.Volumes[]? | select(.Name | test("^baskule-space-[a-zA-Z0-9_-]+$")) | {Name,Labels,Driver,Options}]' > "$stage/volumes.json"
  while read -r name; do
    mount_disk "$name" true
    api -G --data-urlencode 'path=/disk/.' "$url/containers/$helper/archive" > "$stage/disks/$name.tar"
    unmount_disk
  done < <(jq -r '.[].Name' "$stage/volumes.json")
  mkdir "$stage/legacy"
  if [ -n "$legacy" ]; then
    api "$url/volumes" > "$stage/existing.json"
    if jq -e --arg name "$legacy" 'any(.Volumes[]?; .Name == $name)' "$stage/existing.json" >/dev/null; then
      mount_disk "$legacy" true
      api -G --data-urlencode 'path=/disk/.' "$url/containers/$helper/archive" > "$stage/legacy-store.tar"
      unmount_disk
      mkdir "$stage/legacy-store"
      tar -xf "$stage/legacy-store.tar" -C "$stage/legacy-store"
      for data in "$stage/legacy-store"/volumes/baskule-space-*/_data; do
        [ -d "$data" ] || continue
        name=$(basename "$(dirname "$data")")
        [[ "$name" =~ ^baskule-space-[a-zA-Z0-9_-]+$ ]] || exit 1
        tar -C "$(dirname "$data")" -cf "$stage/legacy/$name.tar" _data
      done
    fi
  fi
  tar --xattrs --xattrs-include='*' --numeric-owner -C /backup -cf "$stage/platform.tar" .
  tar -C "$stage" -czf - platform.tar volumes.json disks legacy
  ;;
restore)
  tar -C "$stage" -xzf -
  jq -e --arg instance "$COMPUTERD_INSTANCE" 'type == "array" and all(.[]; (.Name | test("^baskule-space-[a-zA-Z0-9_-]+$")) and .Labels["baskule.managed"] == "true" and .Labels["baskule.instance"] == $instance and .Driver == "local" and ((.Options // {}) | length == 0))' "$stage/volumes.json" >/dev/null
  for directory in /backup/*; do
    [ -z "$(ls -A "$directory")" ] || { echo 'restore requires empty platform volumes' >&2; exit 1; }
  done
  # Reject existing names before changing any data, including another installation's disks.
  api "$url/volumes" > "$stage/existing.json"
  jq -e --slurpfile existing "$stage/existing.json" 'all(.[]; .Name as $name | all($existing[0].Volumes[]?; .Name != $name))' "$stage/volumes.json" >/dev/null
  if [ -d "$stage/legacy" ] && [ -n "$(ls -A "$stage/legacy")" ]; then
    : "${COMPUTER_LEGACY_VOLUME:?legacy volume required to restore unmigrated spaces}"
    # Refuse an existing store rather than overwrite another installation.
    jq -e --arg name "$legacy" 'all(.Volumes[]?; .Name != $name)' "$stage/existing.json" >/dev/null
    for archive in "$stage/legacy/"*.tar; do
      name=$(basename "$archive" .tar)
      [[ "$name" =~ ^baskule-space-[a-zA-Z0-9_-]+$ ]] || exit 1
      mkdir -p "$stage/restore-legacy/volumes/$name"
      tar -xf "$archive" -C "$stage/restore-legacy/volumes/$name"
    done
    api -H 'Content-Type: application/json' -d "$(jq -nc --arg name "$legacy" '{Name:$name}')" "$url/volumes/create" >/dev/null
    tar -C "$stage/restore-legacy" -cf "$stage/restore-legacy.tar" volumes
    mount_disk "$legacy" false
    api -X PUT -H 'Content-Type: application/x-tar' --data-binary "@$stage/restore-legacy.tar" "$url/containers/$helper/archive?path=/disk" >/dev/null
    unmount_disk
  fi
  while read -r metadata; do
    name=$(jq -r .Name <<< "$metadata")
    api -H 'Content-Type: application/json' -d "$metadata" "$url/volumes/create" >/dev/null
    mount_disk "$name" false
    api -X PUT -H 'Content-Type: application/x-tar' --data-binary "@$stage/disks/$name.tar" "$url/containers/$helper/archive?path=/disk" >/dev/null
    unmount_disk
  done < <(jq -c '.[]' "$stage/volumes.json")
  tar --xattrs --xattrs-include='*' --numeric-owner --same-owner --same-permissions -C /backup -xf "$stage/platform.tar"
  ;;
*) exit 2 ;;
esac
