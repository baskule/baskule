#!/bin/bash
set -euo pipefail
: "${COMPUTERD_INSTANCE:?installation identity required}"
: "${BACKUP_IMAGE:?helper image required}"
api() { curl --silent --show-error --fail --unix-socket /var/run/docker.sock "$@"; }
url=http://localhost
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
  tar --xattrs --xattrs-include='*' --numeric-owner -C /backup -cf "$stage/platform.tar" .
  tar -C "$stage" -czf - platform.tar volumes.json disks
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
