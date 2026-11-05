#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/env.sh
space="mig-$(openssl rand -hex 5)"
legacyDisk="baskule-space-$space"
instance="$space-instance"
disk=$(node --input-type=module -e 'import { namesFor } from "./computerd/src/policy.ts"; console.log(namesFor(process.argv[1], process.argv[2]).volume)' "$space" "$instance")
legacy="$space-legacy"
network="$space-network"
image="${MIGRATION_IMAGE:-baskule-computer:local}"
if [ -z "${MIGRATION_IMAGE:-}" ]; then bash computer/build.sh; fi
scripts/docker-build.sh computerd --network host -t baskule-computerd:local -f computerd/Dockerfile .
cleanup() {
  docker rm -f "$disk-migration" >/dev/null 2>&1 || true
  docker volume rm "$disk" "$legacy" >/dev/null
  docker network rm "$network" >/dev/null
  echo "Cleanup complete: $space"
}
docker volume create "$legacy" >/dev/null
docker volume create "$disk" >/dev/null
docker network create --opt com.docker.network.bridge.enable_icc=false "$network" >/dev/null
trap cleanup EXIT
run() { docker run --rm --network none --user 0:0 --entrypoint /bin/sh "$@"; }
run -v "$legacy:/legacy" "$image" -ec '
p=/legacy/volumes/'"$legacyDisk"'/_data
mkdir -p "$p/home/nested"
dd if=/dev/urandom of="$p/home/blob" bs=1M count=1024 status=none
i=0; while [ "$i" -lt 5000 ]; do echo "$i" > "$p/home/nested/$i"; i=$((i+1)); done
echo "#!/bin/sh" > "$p/home/executable"
chmod 751 "$p/home/executable"
ln "$p/home/blob" "$p/home/hardlink"
ln -s nested/42 "$p/home/symlink"
chown -R 1000:1000 "$p"
'
driver() { node computerd/test/migration-driver.ts "$space" "$legacy" "$image" "$network" "$instance"; }
manifest() {
  run -v "$1:/data:ro" "$image" -ec '
cd "/data/$1"
find . ! -name .baskule-migrated -printf "%P %y %m %U %G %n %l\n" | sort
find . -type f ! -name .baskule-migrated -exec sha256sum {} + | sort
' sh "$2"
}
mkdir -p .run/evidence/migration
manifest "$legacy" "volumes/$legacyDisk/_data" > .run/evidence/migration/source
start=$SECONDS
driver
echo "1 GiB + 5000 small files migration: $((SECONDS-start)) seconds"
manifest "$disk" "" > .run/evidence/migration/target
diff -u .run/evidence/migration/source .run/evidence/migration/target
run -v "$disk:/data" "$image" -ec 'echo retained > /data/home/after'
driver
run -v "$disk:/data" "$image" -ec 'test "$(cat /data/home/after)" = retained; rm /data/.baskule-migrated'
driver
run -v "$disk:/data" "$image" -ec 'test "$(cat /data/home/after)" = retained'
# Simulate the crash after marker, before source rename.
run -v "$legacy:/legacy" "$image" -ec 'mv "/legacy/volumes/$1/_data.migrated" "/legacy/volumes/$1/_data"' sh "$legacyDisk"
run -v "$disk:/data" "$image" -ec 'touch /data/.baskule-migrated'
driver
run -v "$disk:/data" "$image" -ec 'test "$(cat /data/home/after)" = retained; rm /data/.baskule-migrated'
# Reset source to exercise an interrupted copy.
run -v "$legacy:/legacy" "$image" -ec 'mv "/legacy/volumes/$1/_data.migrated" "/legacy/volumes/$1/_data"' sh "$legacyDisk"
driver &
pid=$!
deadline=$((SECONDS+60))
until docker exec "$disk-migration" sh -ec 'for f in /target/home/blob /target/home/hardlink; do n=$(stat -c %s "$f" 2>/dev/null || echo 0); if [ "$n" -gt 0 ] && [ "$n" -lt 1073741824 ]; then exit 0; fi; done; exit 1' 2>/dev/null; do
  kill -0 "$pid"
  [ "$SECONDS" -lt "$deadline" ]
done
docker kill "$disk-migration" >/dev/null
if wait "$pid"; then echo "Expected interrupted migration failure"; exit 1; fi
driver
manifest "$disk" "" > .run/evidence/migration/target
diff -u .run/evidence/migration/source .run/evidence/migration/target
echo "PASS: metadata, hashes, hardlinks, no-copy retry, killed-copy recovery"

bash computerd/test/migration-backup.sh
