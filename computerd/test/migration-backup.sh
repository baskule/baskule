#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
image=${BACKUP_TEST_IMAGE:-baskule-celld:local}
if [ -z "${BACKUP_TEST_IMAGE:-}" ]; then scripts/docker-build.sh celld --network host --target source -t "$image" -f deploy/celld/Dockerfile .; fi
legacy="backup-test-$(openssl rand -hex 5)"
stage=$(mktemp -d)
cleanup() { docker volume rm "$legacy" >/dev/null; rm -rf "$stage"; }
trap cleanup EXIT
docker volume create "$legacy" >/dev/null
docker run --rm --network none -v "$legacy:/disk" --entrypoint sh "$image" -ec '
mkdir -p /disk/volumes/baskule-space-old/_data/home /disk/volumes/baskule-space-done/_data.migrated
echo retained > /disk/volumes/baskule-space-old/_data/home/data
'
job() {
 docker run --rm -i --network none --entrypoint bash  -e COMPUTERD_INSTANCE="$legacy" -e COMPUTER_LEGACY_VOLUME="$legacy" -e BACKUP_IMAGE="$image"  -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/deploy/celld/backup.sh:/test.sh:ro"  -v "$stage/platform:/backup" "$image" /test.sh "$1"
}
mkdir -p "$stage/platform/storage"
job backup > "$stage/backup.tar.gz"
tar -tzf "$stage/backup.tar.gz" | grep 'legacy/baskule-space-old.tar'
if tar -tzf "$stage/backup.tar.gz" | grep 'legacy/baskule-space-done'; then exit 1; fi
docker volume rm "$legacy" >/dev/null
job restore < "$stage/backup.tar.gz"
docker run --rm --network none -v "$legacy:/disk:ro" --entrypoint sh "$image" -ec '
test "$(cat /disk/volumes/baskule-space-old/_data/home/data)" = retained
test ! -e /disk/volumes/baskule-space-done
'
echo 'PASS: unmigrated legacy backup and restore'
