#!/usr/bin/env bash
# Stop the shared development gateway. --purge also deletes its volumes and network.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../scripts/env.sh"
SHARED=$BASKULE_SHARED
mkdir -p "$SHARED/run/locks"
exec 9>"$SHARED/run/locks/stack-shared-gateway.lock"
flock -x -w 600 9
# An unreadable registry cannot establish that removing shared infrastructure is safe.
status=0
node --input-type=module - "$SHARED/run/stacks" <<'JS' || status=$?
import { existsSync, readdirSync, readFileSync } from "node:fs";
const dir = process.argv[2];
let inUse = false;
for (const file of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")) : []) {
  const s = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
  if (!s.definition || !Array.isArray(s.definition.shared)) throw new Error(`Invalid stack registry: ${file}`);
  inUse ||= s.definition.shared.includes("gateway");
}
process.exit(inUse ? 2 : 0);
JS
if [ "$status" = 2 ]; then
  echo "dev gateway kept: worktree stacks still registered (scripts/stack gc prunes dead entries)"
  exit 0
elif [ "$status" != 0 ]; then
  echo "dev gateway kept: cannot read stack registry; restore Node/repair the reported file, then retry" >&2
  exit 1
fi
container=$(docker ps -aq --filter 'name=^/osdev-openshell$')
if [ -n "$container" ]; then docker rm -f osdev-openshell >/dev/null; fi
if [ "${1:-}" = "--purge" ]; then
  for volume in osdev-openshell-docker osdev-openshell-state; do
    if [ -n "$(docker volume ls -q --filter "name=^${volume}$")" ]; then docker volume rm "$volume" >/dev/null; fi
  done
  if [ -n "$(docker network ls -q --filter 'name=^osdev-openshell-net$')" ]; then docker network rm osdev-openshell-net >/dev/null; fi
fi
echo "dev openshell down"
