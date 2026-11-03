#!/usr/bin/env bash
# Requires the owner's authorization and SCW_* credentials in the environment.
# No GCP access, production context, bucket, or cloud LoadBalancer is used.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
export PATH="$HOME/.local/bin:$PATH"
: "${SCW_ACCESS_KEY:?}" "${SCW_SECRET_KEY:?}" "${SCW_DEFAULT_PROJECT_ID:?}"
export SCW_DEFAULT_REGION=fr-par SCW_DEFAULT_ZONE=fr-par-1
marker=baskule-ephemeral
state="$root/.run/kubernetes-ephemeral"
mkdir -p "$state"
umask 077
scw_json() { scw "$@" -o json; }
# Every selector below is limited to this tool's explicit marker or name prefix.
marked_ids() { jq -r --arg marker "$marker" '.[] | select((.tags // [] | index($marker)) != null) | .id'; }
inventory() {
  scw_json k8s cluster list > "$state/clusters.private.json"
  local pools="$state/pools.private.ndjson"
  : > "$pools"
  while read -r id; do scw_json k8s pool list "cluster-id=$id" | jq -c '.[]' >> "$pools"; done < <(jq -r '.[].id' "$state/clusters.private.json")
  jq -s . "$pools" > "$state/pools.private.json"
  scw_json registry namespace list > "$state/registries.private.json"
  scw_json lb lb list zone=all > "$state/lbs.private.json"
  scw_json block volume list zone=all > "$state/volumes.private.json"
  scw_json instance ip list zone=all > "$state/ips.private.json"
  scw_json instance server list zone=all > "$state/instances.private.json"
  scw_json lb ip list zone=all > "$state/lb-ips.private.json"
}
sweep() {
  inventory || return 1
  while read -r id; do scw k8s cluster delete "$id" with-additional-resources=true --wait >/dev/null; done < <(marked_ids < "$state/clusters.private.json")
  while read -r id; do scw registry namespace delete "$id" >/dev/null; done < <(jq -r --arg prefix "$marker-" '.[] | select(.name | startswith($prefix)) | .id' "$state/registries.private.json")
  inventory || return 1
  # Only leftovers explicitly tagged by the run can be deleted here.
  while read -r id zone; do scw instance server delete "$id" "zone=$zone" with-volumes=all with-ip=true force-shutdown=true --wait >/dev/null; done < <(jq -r --arg marker "$marker" '.[] | select(.tags // [] | index($marker)) | "\(.id) \(.zone)"' "$state/instances.private.json")
  while read -r id zone; do scw lb lb delete "$id" "zone=$zone" release-ip=true >/dev/null; done < <(jq -r --arg marker "$marker" '.[] | select(.tags // [] | index($marker)) | "\(.id) \(.zone)"' "$state/lbs.private.json")
  while read -r id zone; do scw block volume delete "$id" "zone=$zone" >/dev/null; done < <(jq -r --arg marker "$marker" '.[] | select(.tags // [] | index($marker)) | "\(.id) \(.zone)"' "$state/volumes.private.json")
  while read -r id zone; do scw instance ip delete "$id" "zone=$zone" >/dev/null; done < <(jq -r --arg marker "$marker" '.[] | select(.tags // [] | index($marker)) | "\(.id) \(.zone)"' "$state/ips.private.json")
  while read -r id zone; do scw lb ip release "$id" "zone=$zone" >/dev/null; done < <(jq -r --arg marker "$marker" '.[] | select(.tags // [] | index($marker)) | "\(.id) \(.zone)"' "$state/lb-ips.private.json")
  audit
}
audit() {
  inventory || return 1
  local remaining=0 count
  for kind in clusters pools instances lbs volumes ips lb-ips; do
    count=$(marked_ids < "$state/$kind.private.json" | wc -l)
    printf '%s: %s tagged resources\n' "$kind" "$count"
    remaining=$((remaining + count))
  done
  count=$(jq --arg prefix "$marker-" '[.[] | select(.name | startswith($prefix))] | length' "$state/registries.private.json")
  printf 'registries: %s matching namespaces\n' "$count"
  (( remaining + count == 0 ))
}
case "${1:-}" in
  sweep) sweep; exit ;;
  audit) audit; exit ;;
  run)
    # timeout is the independent lifetime limit. TERM runs the worker's EXIT trap.
    exec timeout --signal=TERM --kill-after=10m 90m bash "$0" worker ;;
  worker) ;;
  *) echo "Usage: $0 run|sweep|audit" >&2; exit 2 ;;
esac
run_id="$marker-$(date -u +%Y%m%d%H%M%S)"
export BASKULE_K8S_EVIDENCE="$root/.run/evidence/$run_id"
mkdir -p "$BASKULE_K8S_EVIDENCE"
export KUBECONFIG="$state/$run_id.kubeconfig.private"
export DOCKER_CONFIG="$state/$run_id.docker.private"
mkdir -p "$DOCKER_CONFIG"
started=$(date +%s)
cluster_id= registry_id= volume_watcher=
nodes_started=0
cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  [[ -z $volume_watcher ]] || kill -TERM -- "-$volume_watcher" 2>/dev/null
  # Capture CSI volume identities and tag them before deleting any Kubernetes state.
  if [[ -f $KUBECONFIG ]]; then
    kubectl get pv -o json > "$state/$run_id.pv.private.json"
    while read -r handle; do
      id=${handle##*/}
      scw block volume update "$id" "tags.0=$marker" "tags.1=$run_id" > /dev/null
    done < <(jq -r '.items[].spec.csi.volumeHandle // empty' "$state/$run_id.pv.private.json")
    kubectl -n baskule get events --sort-by=.lastTimestamp > "$BASKULE_K8S_EVIDENCE/events.txt"
    kubectl -n baskule delete sandboxes --all --wait=true --timeout=120s > /dev/null
    helm uninstall baskule -n baskule --wait --timeout 120s > /dev/null
    kubectl -n baskule delete pvc --all --wait=true --timeout=120s > /dev/null
  fi
  # Also finds a cluster created just before interruption, before its ID was saved.
  if [[ -n $cluster_id ]]; then scw k8s cluster delete "$cluster_id" with-additional-resources=true --wait > /dev/null; fi
  if [[ -n $registry_id ]]; then scw registry namespace delete "$registry_id" > /dev/null; fi
  sweep > "$BASKULE_K8S_EVIDENCE/cleanup-audit.txt" 2>&1
  cleanup_status=$?
  finished=$(date +%s)
  elapsed=$(( finished - started ))
  node_seconds=0
  (( nodes_started == 0 )) || node_seconds=$(( finished - nodes_started ))
  printf 'elapsed_seconds=%s\nnode_type=DEV1-L\nnode_count=2\nmaximum_node_type_hours=%s\ncleanup_status=%s\n' \
    "$elapsed" "$(awk -v s="$node_seconds" 'BEGIN {printf "%.4f", 2*s/3600}')" "$cleanup_status" > "$BASKULE_K8S_EVIDENCE/cost.txt"
  rm -f "$KUBECONFIG"
  rm -rf "$DOCKER_CONFIG"
  (( cleanup_status == 0 )) || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Refuse a new run when a previous tagged installation still needs cleanup.
audit > "$BASKULE_K8S_EVIDENCE/before-audit.txt"
BASKULE_VERSION=0.0.0-ephemeral scripts/helm-package.sh "$BASKULE_K8S_EVIDENCE" > "$BASKULE_K8S_EVIDENCE/chart-package.log"
export BASKULE_K8S_CHART="$BASKULE_K8S_EVIDENCE/baskule-0.0.0-ephemeral.tgz"
scw_json registry namespace create "name=$run_id" "description=$marker $run_id" is-public=true > "$state/$run_id.registry.private.json"
registry_id=$(jq -er .id "$state/$run_id.registry.private.json")
export BASKULE_K8S_REGISTRY
BASKULE_K8S_REGISTRY=$(jq -er .endpoint "$state/$run_id.registry.private.json")
printf '%s' "$SCW_SECRET_KEY" | docker login "${BASKULE_K8S_REGISTRY%%/*}" -u nologin --password-stdin > /dev/null
export BASKULE_K8S_TAG=${BASKULE_K8S_TAG:-kubernetes}
for name in celld computerd openshell-kubernetes computer openshell-supervisor openshell-sandbox; do
  docker tag "baskule-$name:$BASKULE_K8S_TAG" "$BASKULE_K8S_REGISTRY/baskule-$name:$BASKULE_K8S_TAG"
  docker push "$BASKULE_K8S_REGISTRY/baskule-$name:$BASKULE_K8S_TAG" > "$BASKULE_K8S_EVIDENCE/push-$name.log" 2>&1
done
# 2 x 4 vCPU/8 GiB: enough allocatable CPU for a 2-CPU computer and control pods,
# with a second node for the actual cross-node CSI reattachment drill.
nodes_started=$(date +%s)
scw_json k8s cluster create "name=$run_id" "version=${BASKULE_K8S_VERSION:-1.35.9}" cni=calico "tags.0=$marker" "tags.1=$run_id" \
  pools.0.name=computers pools.0.zone=fr-par-1 pools.0.node-type=DEV1-L pools.0.size=2 pools.0.root-volume-size=40GB \
  "pools.0.tags.0=$marker" "pools.0.tags.1=$run_id" --wait > "$state/$run_id.cluster.private.json"
cluster_id=$(jq -er .id "$state/$run_id.cluster.private.json")
scw k8s kubeconfig install "$cluster_id" auth-method=copy-cli-token >/dev/null
kubectl wait --for=condition=Ready nodes --all --timeout=600s
# Tag node IPs explicitly; namespaces in Container Registry have no tags API.
kubectl get nodes -o json | jq '[.items[].spec.providerID | split("/") | last]' > "$state/$run_id.nodes.private.json"
scw_json instance ip list | jq -r --slurpfile nodes "$state/$run_id.nodes.private.json" '.[] | . as $ip | select($nodes[0] | index($ip.server.id)) | .id' | while read -r id; do
  scw instance ip update "$id" "tags.0=$marker" "tags.1=$run_id" >/dev/null
done
# Tag PVC block volumes as soon as CSI creates the PV. No polling or sleeps.
setsid bash -c '
  kubectl get pv --watch --output-watch-events -o json | jq --unbuffered -r ".object.spec.csi.volumeHandle // empty" | while read -r handle; do
    scw block volume update "${handle##*/}" "tags.0=$1" "tags.1=$2" >/dev/null
  done
' bash "$marker" "$run_id" > "$state/$run_id.volume-tags.private.log" 2>&1 &
volume_watcher=$!
export BASKULE_K8S_CROSS_NODE=1
bash e2e/kubernetes-install.sh > "$BASKULE_K8S_EVIDENCE/install.log" 2>&1
