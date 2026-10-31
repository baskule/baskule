# Shared helpers for deploy scripts (sourced).
DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$DEPLOY_DIR/.." && pwd)
TAG=${BASKULE_TAG:-local}
# If ~/.docker/buildx is not writable, use a private Docker CLI config directory.
[ -w "$HOME/.docker/buildx/activity/default" ] 2>/dev/null || export DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.local/baskule/docker-cli}
mkdir -p "${DOCKER_CONFIG:-$HOME/.docker}"
# Compose builds use the host network so they do not require a docker0 bridge.
export COMPOSE_BAKE=false
# An external bucket (.env sets S3_ENDPOINT, see dedicated-host.md) adds docker-compose.s3.yml: no RustFS.
dc() {
  local f=(-f "$DEPLOY_DIR/docker-compose.yml")
  [ -n "$(env_get S3_ENDPOINT 2>/dev/null)" ] && f+=(-f "$DEPLOY_DIR/docker-compose.s3.yml")
  docker compose --project-directory "$DEPLOY_DIR" "${f[@]}" "$@"
}
log() { echo "[baskule] $*" >&2; }
wait_healthy() { # wait_healthy <container> [seconds]
  local c=$1 t=${2:-180} s
  for _ in $(seq "$t"); do
    s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || true)
    [ "$s" = healthy ] && return 0
    sleep 1
  done
  log "$c not healthy (status: $s)"; docker logs --tail 30 "$c" >&2; return 1
}
# Read one value from .env literally (never `source` it: values such as JSON would be mangled by the shell and
# would then override compose's own .env parsing).
env_get() { sed -n "s/^$1=//p" "$DEPLOY_DIR/.env" | tail -1; }
# Stack lock (deploy/.stack-lock, gitignored): whoever runs tests against the shared stack holds it, so others do
# not redeploy or take the stack down meanwhile. Content: "owner=<who> pid=<pid> host=<host> since=<UTC> note=<text>".
# A lock older than 3 h, or whose pid is gone, is stale. STACK_LOCK_OWNER identifies you (default: $USER-<script>).
STACK_LOCK=$DEPLOY_DIR/.stack-lock
stack_lock_owner() { echo "${STACK_LOCK_OWNER:-$USER-$(basename "$0")}"; }
stack_lock_stale() {
  [ -f "$STACK_LOCK" ] || return 0
  local pid age
  pid=$(sed -n 's/.*pid=\([0-9]*\).*/\1/p' "$STACK_LOCK")
  age=$(( $(date +%s) - $(stat -c %Y "$STACK_LOCK") ))
  [ "$age" -gt 10800 ] && return 0
  [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null && return 0
  return 1
}
stack_lock_mine() { [ -f "$STACK_LOCK" ] && grep -q "owner=$(stack_lock_owner) " "$STACK_LOCK"; }
# stack_lock_check: fail if another live owner holds the lock (STACK_LOCK_IGNORE=1 overrides).
stack_lock_check() {
  [ "${STACK_LOCK_IGNORE:-0}" = 1 ] && return 0
  if [ -f "$STACK_LOCK" ] && ! stack_lock_mine && ! stack_lock_stale; then
    log "the stack is locked: $(cat "$STACK_LOCK") — wait, or ask its owner (STACK_LOCK_IGNORE=1 overrides)"; return 1
  fi
}
# stack_lock_acquire <pid> <note>: take the lock (waits up to STACK_LOCK_WAIT seconds, default 0).
stack_lock_acquire() {
  local w=${STACK_LOCK_WAIT:-0}
  while ! stack_lock_check 2>/dev/null; do
    [ "$w" -le 0 ] && { stack_lock_check; return 1; }
    sleep 10; w=$((w - 10))
  done
  echo "owner=$(stack_lock_owner) pid=$1 host=$(hostname) since=$(date -u +%FT%TZ) note=$2" >"$STACK_LOCK"
}
stack_lock_release() { stack_lock_mine && rm -f "$STACK_LOCK"; return 0; }
