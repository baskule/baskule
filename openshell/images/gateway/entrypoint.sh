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

# 2. Runtime images baked into this image (the gateway checks the supervisor image at startup).
while read -r file created tag; do
  [ -n "$tag" ] || continue
  if [ "$(docker image inspect --format '{{.Created}}' "$tag" 2>/dev/null)" != "$created" ]; then
    docker load -q -i "/usr/local/lib/baskule/images/$file" >/dev/null && log "loaded $tag"
  fi
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
#    load-images.sh use), and OPENSHELL_OTLP_ENDPOINT (an OTLP/gRPC collector) adds trace export.
CONFIG=/var/run/openshell-gateway.toml
TAG=${BASKULE_TAG:-local}
sed "s/\(baskule-[a-z-]*\):local\"/\1:$TAG\"/" /etc/openshell/gateway.toml > "$CONFIG"
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
# Any child exiting takes the container down (compose restarts it).
set +e
wait -n "$DOCKERD_PID" "$GATEWAY_PID" "$VOLUMES_PID"
code=$?
log "a child exited ($code); shutting down"
term
