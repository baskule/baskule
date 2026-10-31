#!/bin/bash
# baskule-openshell entrypoint: private dockerd + OpenShell gateway + volume helper, in one container.
# Runs under tini; the first stage re-execs itself through `dind` (cgroup v2 nesting, securityfs).
set -euo pipefail
if [ "${1:-}" != "--inner" ]; then exec dind "$0" --inner; fi

log() { echo "[baskule-openshell] $*" >&2; }
mkdir -p /var/lib/openshell/state /var/run

# 1. Private dockerd: unix socket only, no bridge, no iptables (sandboxes run --network none, supervisors host-net).
dockerd --host=unix:///var/run/docker.sock --bridge=none --iptables=false --ip6tables=false \
  --log-level="${DOCKERD_LOG_LEVEL:-warn}" &
DOCKERD_PID=$!
for _ in $(seq 120); do docker info >/dev/null 2>&1 && break; sleep 0.5; done
docker info >/dev/null 2>&1 || { log "dockerd did not start"; exit 1; }
log "dockerd $(docker version --format '{{.Server.Version}}') ready"

# 2. All workload images are bundled, including the computer. No host image loader is needed.
REGISTRY=${BASKULE_REGISTRY:-}
TAG=${BASKULE_VERSION:-${BASKULE_TAG:-local}}
while read -r file created tag; do
  [ -n "$tag" ] || continue
  if [ "$(docker image inspect --format '{{.Created}}' "$tag" 2>/dev/null)" != "$created" ]; then
    docker load -q -i "/usr/local/lib/baskule/images/$file" >/dev/null && log "loaded $tag"
  fi
  name=${tag%:*}
  docker tag "$tag" "${REGISTRY:+$REGISTRY/}$name:$TAG"
done < /usr/local/lib/baskule/images/images.txt

# 3. Supervisor JWT keys (kept across restarts on the state volume).
if [ ! -s /var/lib/openshell/tls/jwt/signing.pem ]; then
  openshell-gateway generate-certs --output-dir /var/lib/openshell/tls >/dev/null
  log "generated gateway keys"
fi

# 4. Volume helper (per-space labelled volumes; token-protected).
python3 /usr/local/lib/baskule/volumes.py &
VOLUMES_PID=$!

# 5. Gateway, on the baked config rendered for this stack: image tags follow BASKULE_TAG (the tag compose and
#    source builds use), and OPENSHELL_OTLP_ENDPOINT adds optional OTLP/gRPC trace export.
CONFIG=/var/run/openshell-gateway.toml
sed "s#\(baskule-[a-z-]*\):local\"#${REGISTRY:+$REGISTRY/}\1:$TAG\"#" /etc/openshell/gateway.toml > "$CONFIG"
if [ -n "${OPENSHELL_OTLP_ENDPOINT:-}" ]; then
  printf '\n[openshell.gateway.otlp]\nendpoint = "%s"\n' "$OPENSHELL_OTLP_ENDPOINT" >> "$CONFIG"
  log "trace export to $OPENSHELL_OTLP_ENDPOINT"
fi
openshell-gateway --config "$CONFIG" &
GATEWAY_PID=$!

term() {
  log "stopping"
  kill -TERM "$GATEWAY_PID" "$VOLUMES_PID" 2>/dev/null || true
  wait "$GATEWAY_PID" 2>/dev/null || true
  kill -TERM "$DOCKERD_PID" 2>/dev/null || true
  wait "$DOCKERD_PID" 2>/dev/null || true
  exit 0
}
trap term TERM INT
# Updating the gateway also updates existing computers. Delete stale sandboxes through OpenShell so its
# bookkeeping stays consistent; attachable space volumes survive and are reused on the next command.
for _ in $(seq 120); do
  curl -sf -o /dev/null http://127.0.0.1:47097/readyz && break
  sleep 1
done
curl -sf -o /dev/null http://127.0.0.1:47097/readyz
want=$(docker image inspect -f '{{.Id}}' "${REGISTRY:+$REGISTRY/}baskule-computer:$TAG")
ids=$(docker ps -aq --filter label=baskule.managed=true --filter label=openshell.ai/isolation-role=sandbox)
if [ -n "$ids" ]; then
  names=$(docker inspect -f '{{.Image}} {{index .Config.Labels "openshell.ai/sandbox-name"}}' $ids |
    awk -v want="$want" '$1 != want && $2 ~ /^os-/ {print $2}')
  for name in $names; do
    openshell --gateway-endpoint http://127.0.0.1:47095 sandbox delete "$name" >/dev/null
    log "updated computer $name (disk kept)"
  done
fi
touch /var/run/baskule-ready
# Any child exiting takes the container down (compose restarts it).
set +e
wait -n "$DOCKERD_PID" "$GATEWAY_PID" "$VOLUMES_PID"
code=$?
log "a child exited ($code); shutting down"
term
