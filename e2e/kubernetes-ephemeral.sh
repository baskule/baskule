#!/usr/bin/env bash
# Owner-authorized GKE Standard verification. Never changes gcloud configuration.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
export PATH="$HOME/.local/bin:$PATH"
project=${BASKULE_GKE_PROJECT:?set the owner-authorized project}
[[ $project == "$(gcloud config get-value project 2>/dev/null)" ]] || { echo 'Authorized project must match the active project' >&2; exit 1; }
region=europe-west1
zone=$region-b
marker=baskule-ephemeral
resource_scope=
state_root="$root/.run/kubernetes-ephemeral"
mkdir -p "$state_root"
umask 077
state=$(mktemp -d "$state_root/gke.XXXXXX")
printf '%s' "$project" > "$state/project.private"
printf '[]' > "$state/owned-links.private.json"
gc() { gcloud --project="$project" --quiet "$@"; }
owned_filter='def marked:
  (.labels // .resourceLabels // {}) as $labels |
  ($labels["baskule-run"] == $marker) or
  ($marker == "baskule-ephemeral" and $labels["baskule-ephemeral"] == "true") or
  ([$labels["baskule-run"], $labels["goog-k8s-cluster-name"], .description, .displayName,
    (if .email then null else (.name // "" | split("/") | last) end)] | any(.[] | strings; contains($marker)));
'
kinds=(instances disks forwarding-rules target-http-proxies target-https-proxies url-maps backend-services target-pools health-checks http-health-checks https-health-checks addresses network-endpoint-groups firewall-rules)
inventory() {
  jq -e 'type == "array"' "$state/owned-links.private.json" >/dev/null || return
  gc container clusters list --format=json > "$state/clusters.private.json" || return
  gc artifacts repositories list --location=all --format=json > "$state/repositories.private.json" || return
  gc iam service-accounts list --format=json > "$state/accounts.private.json" || return
  local kind inputs=("$state/clusters.private.json" "$state/repositories.private.json" "$state/accounts.private.json")
  for kind in "${kinds[@]}"; do
    gc compute "$kind" list --format=json > "$state/$kind.private.json" || return
    inputs+=("$state/$kind.private.json")
  done
  # Persist references before controllers remove their parent objects, so sweep
  # can still identify a leftover health check/NEG after an interrupted deletion.
  jq -s --arg marker "${resource_scope:-$marker}" --arg project "$project" --slurpfile saved "$state/owned-links.private.json" "$owned_filter"'
    (if all(.[]; type == "array") then flatten else error("Resource inventory must contain arrays") end) as $resources |
    def expand($links): ($links + [$resources[] |
      select(marked or (.selfLink as $url | $links | index($url))) |
      .. | strings | select(contains("/projects/" + $project + "/"))]) | unique;
    $saved[0] | until(expand(.) == .; expand(.))
  ' "${inputs[@]}" > "$state/links.next" || return
  mv "$state/links.next" "$state/owned-links.private.json"
}
owned() {
  # LB objects without a labels API carry the unique namespace in descriptions.
  jq -r --arg marker "${resource_scope:-$marker}" --slurpfile links "$state/owned-links.private.json" "$owned_filter"'.[] | select(marked or (.selfLink as $url | $links[0] | index($url))) | [.name, (.zone // .region // "global" | split("/") | last)] | @tsv'
}
audit() {
  inventory || return
  local kind count remaining=0
  for kind in clusters repositories accounts "${kinds[@]}"; do
    count=$(owned < "$state/$kind.private.json" | wc -l) || return
    printf '%s: %s owned resources\n' "$kind" "$count"
    remaining=$((remaining + count))
  done
  # Surface unlabelled LB/PVC orphans added since this run's baseline as well.
  if [[ -d $state/before ]]; then
    for kind in disks forwarding-rules addresses target-pools backend-services health-checks http-health-checks https-health-checks; do
      count=$(jq -s '.[0] as $before | [.[1][] | . as $resource | select(any($before[]; .selfLink == $resource.selfLink) | not)] | length' "$state/before/$kind.private.json" "$state/$kind.private.json") || return
      printf '%s: %s resources added since baseline\n' "$kind" "$count"
      remaining=$((remaining + count))
    done
  fi
  (( remaining == 0 ))
}
sweep() {
  inventory || return
  local name location kind flag email
  while read -r name location; do gc container clusters delete "$name" --zone="$location" || true; done < <(jq -r --arg marker "${resource_scope:-$marker}" "$owned_filter"'.[] | select(marked) | [.name,.location] | @tsv' "$state/clusters.private.json")
  inventory || return
  # Delete dependants first. Never delete an unrelated resource on an audit guess.
  for kind in forwarding-rules target-http-proxies target-https-proxies url-maps backend-services target-pools health-checks http-health-checks https-health-checks network-endpoint-groups instances disks addresses firewall-rules; do
    while read -r name location; do
      case $kind in
        instances|network-endpoint-groups) flag=zone ;;
        firewall-rules|http-health-checks|https-health-checks) flag= ;;
        *) if [[ $location == global ]]; then flag=global; elif [[ $location =~ -[a-z]$ ]]; then flag=zone; else flag=region; fi ;;
      esac
      args=("$name")
      if [[ $flag == global ]]; then args+=(--global); elif [[ -n $flag ]]; then args+=("--$flag=$location"); fi
      gc compute "$kind" delete "${args[@]}" || true
    done < <(owned < "$state/$kind.private.json")
  done
  while read -r name; do gc artifacts repositories delete "$name" --location="$region" || true; done < <(owned < "$state/repositories.private.json" | cut -f1 | sed 's|.*/||')
  while read -r email; do
    gc projects remove-iam-policy-binding "$project" --member="serviceAccount:$email" --role=roles/container.defaultNodeServiceAccount --condition=None >/dev/null || true
    gc iam service-accounts delete "$email" || true
  done < <(jq -r --arg marker "${resource_scope:-$marker}" "$owned_filter"'.[] | select(marked) | .email' "$state/accounts.private.json")
  audit
}
case "${1:-}" in
  sweep|audit)
    # Recover saved ownership from interrupted runs, confined to this project.
    for previous in "$state_root"/gke.*; do
      [[ -f $previous/project.private && $(cat "$previous/project.private") == "$project" && -f $previous/owned-links.private.json ]] || continue
      jq -e 'type == "array"' "$previous/owned-links.private.json" >/dev/null || exit 1
      jq -s 'add | unique' "$state/owned-links.private.json" "$previous/owned-links.private.json" > "$state/links.next"
      mv "$state/links.next" "$state/owned-links.private.json"
    done
    "$1"; exit ;;
  # Snapshot into bash's input string so edits cannot change an in-flight run.
  run) exec timeout --signal=TERM --kill-after=10m 90m bash -c "$(cat "$0")" "$0" worker ;;
  worker) ;;
  *) echo "Usage: $0 run|sweep|audit" >&2; exit 2 ;;
esac
run_id="$marker-$(date -u +%s)-$(od -An -N2 -tx1 /dev/urandom | tr -d '[:space:]')"
labels="$marker=true,baskule-run=$run_id"
export BASKULE_K8S_EVIDENCE="$root/.run/evidence/$run_id"
export KUBECONFIG="$state/kubeconfig.private" DOCKER_CONFIG="$state/docker.private"
export HELM_REGISTRY_CONFIG="$DOCKER_CONFIG/helm-registry.json"
export BASKULE_K8S_NAMESPACE="$run_id" BASKULE_K8S_RELEASE=baskule
mkdir -p "$BASKULE_K8S_EVIDENCE" "$DOCKER_CONFIG"
started=$(date +%s)
nodes_started=0
cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -f $KUBECONFIG ]]; then
    kubectl -n "$run_id" get pods -o json > "$state/pods.private.json"
    while read -r pod; do
      kubectl -n "$run_id" logs "$pod" --all-containers --request-timeout=20s > "$state/$pod.private.log" 2>&1
    done < <(jq -r '.items[].metadata.name' "$state/pods.private.json")
  fi
  inventory
  while read -r name location; do
    gc logging read "resource.type=\"http_load_balancer\" AND resource.labels.forwarding_rule_name=\"$name\" AND httpRequest.status>=500" \
      --limit=20 --freshness=2h --format=json > "$state/$name.lb-errors.private.json"
  done < <(owned < "$state/forwarding-rules.private.json")
  # The CLI's labels flag uses the gated alpha API; use the stable setLabels API.
  python3 - "$project" "$run_id" "$state/forwarding-rules.private.json" <<'PY'
import json, subprocess, sys, urllib.request
project, run, inventory = sys.argv[1:]
rules = [r for r in json.load(open(inventory)) if run in json.dumps(r)]
if rules:
    token = subprocess.check_output(['gcloud', '--project=' + project, 'auth', 'print-access-token'], text=True).strip()
    for rule in rules:
        url = rule['selfLink'] + '/setLabels'
        assert '/projects/' + project + '/' in url
        body = {'labels': {**rule.get('labels', {}), 'baskule-ephemeral': 'true', 'baskule-run': run}, 'labelFingerprint': rule.get('labelFingerprint', '')}
        request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(request, timeout=30) as response: response.read()
PY
  if [[ -f $KUBECONFIG ]]; then
    kubectl -n "$run_id" get events --sort-by=.lastTimestamp > "$BASKULE_K8S_EVIDENCE/events.txt" 2>/dev/null
    kubectl -n "$run_id" delete ingress --all --timeout=180s >/dev/null
    kubectl -n "$run_id" delete sandboxes --all --timeout=120s >/dev/null
    helm uninstall baskule -n "$run_id" --wait --timeout 120s >/dev/null
    kubectl -n "$run_id" delete pvc --all --timeout=120s >/dev/null
  fi
  # Attempt known resource deletion even if an inventory API was unavailable.
  gc container clusters delete "$run_id" --zone="$zone" >/dev/null 2>&1
  gc artifacts repositories delete "$run_id" --location="$region" >/dev/null 2>&1
  sweep > "$BASKULE_K8S_EVIDENCE/cleanup-audit.txt" 2>&1
  cleanup_status=$?
  elapsed=$(( $(date +%s) - started ))
  seconds=0
  (( nodes_started == 0 )) || seconds=$(( $(date +%s) - nodes_started ))
  printf 'elapsed_seconds=%s\nnode_type=e2-custom-4-8192\nspot=true\nnode_count=2\nmaximum_node_hours=%s\ncleanup_status=%s\n' \
    "$elapsed" "$(awk -v s="$seconds" 'BEGIN {printf "%.4f", 2*s/3600}')" "$cleanup_status" > "$BASKULE_K8S_EVIDENCE/cost.txt"
  gc compute operations list --filter='operationType=delete' --format=json > "$state/deletes.private.json"
  python3 - "$BASKULE_K8S_EVIDENCE" "$state/deletes.private.json" "$elapsed" <<'PY'
import json, sys
from datetime import datetime
from pathlib import Path
evidence, operations, elapsed = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
nodes_file = evidence / 'node-times.json'
if nodes_file.exists():
    nodes = json.loads(nodes_file.read_text())
    ends = {o['targetLink']: o['endTime'] for o in json.loads(operations.read_text()) if o.get('endTime')}
    if nodes and all(n['selfLink'] in ends for n in nodes):
        hours = sum((datetime.fromisoformat(ends[n['selfLink']]) - datetime.fromisoformat(n['creationTimestamp'])).total_seconds() / 3600 for n in nodes)
        # Conservative estimate: $0.07/Spot node-hour plus $0.16/run-hour for
        # control plane, LB, IPs, disks and registry. Excludes data transfer.
        (evidence / 'cost.json').write_text(json.dumps({'observedNodeHours': round(hours, 4), 'estimatedUsd': round(hours * .07 + elapsed / 3600 * .16, 3), 'dataTransferIncluded': False}, indent=2) + '\n')
PY
  rm -f "$KUBECONFIG"
  rm -rf "$DOCKER_CONFIG"
  (( cleanup_status == 0 )) || status=1
  exit "$status"
}
if ! audit > "$BASKULE_K8S_EVIDENCE/before-audit.txt"; then
  cat "$BASKULE_K8S_EVIDENCE/before-audit.txt" >&2
  exit 1
fi
# Nothing exists for this run before preflight succeeds. Never install a cleanup
# trap with another run's ownership references from that global audit.
resource_scope=$run_id
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$state/before"
cp "$state/"*.private.json "$state/before/"
BASKULE_VERSION=0.0.0-ephemeral scripts/helm-package.sh "$BASKULE_K8S_EVIDENCE" > "$BASKULE_K8S_EVIDENCE/chart-package.log"
export BASKULE_K8S_CHART="$BASKULE_K8S_EVIDENCE/baskule-0.0.0-ephemeral.tgz"
gc artifacts repositories create "$run_id" --location="$region" --repository-format=docker --labels="$labels" > "$BASKULE_K8S_EVIDENCE/registry-create.log" 2>&1
export BASKULE_K8S_REGISTRY="$region-docker.pkg.dev/$project/$run_id"
gc auth print-access-token | docker login "$region-docker.pkg.dev" -u oauth2accesstoken --password-stdin >/dev/null
gc auth print-access-token | helm registry login "$region-docker.pkg.dev" --username oauth2accesstoken --password-stdin >/dev/null
helm push "$BASKULE_K8S_CHART" "oci://$BASKULE_K8S_REGISTRY" > "$BASKULE_K8S_EVIDENCE/chart-push.log" 2>&1
export BASKULE_K8S_CHART="oci://$BASKULE_K8S_REGISTRY/baskule"
export BASKULE_K8S_CHART_VERSION=0.0.0-ephemeral
export BASKULE_K8S_TAG=${BASKULE_K8S_TAG:-kubernetes}
for name in celld computerd openshell-kubernetes computer openshell-supervisor openshell-sandbox; do
  docker tag "baskule-$name:$BASKULE_K8S_TAG" "$BASKULE_K8S_REGISTRY/baskule-$name:$BASKULE_K8S_TAG"
  for attempt in 1 2 3; do
    if docker push "$BASKULE_K8S_REGISTRY/baskule-$name:$BASKULE_K8S_TAG" >> "$BASKULE_K8S_EVIDENCE/push-$name.log" 2>&1; then break; fi
    if [[ $attempt == 3 ]]; then exit 1; fi
  done
done
# Disposable node identity; no grants to an existing service account.
account="bk-${run_id#baskule-ephemeral-}"
email="$account@$project.iam.gserviceaccount.com"
gc iam service-accounts create "$account" --display-name="$run_id" --description="$labels" >/dev/null
gc projects add-iam-policy-binding "$project" --member="serviceAccount:$email" --role=roles/container.defaultNodeServiceAccount --condition=None >/dev/null
gc artifacts repositories add-iam-policy-binding "$run_id" --location="$region" --member="serviceAccount:$email" --role=roles/artifactregistry.reader >/dev/null
# Two 4-vCPU/8-GiB Spot nodes fit a 2-CPU computer plus platform services and
# allow zonal PD reattachment onto a different node. No regional x3 pool.
nodes_started=$(date +%s)
gc container clusters create "$run_id" --zone="$zone" --node-locations="$zone" \
  --num-nodes=2 --machine-type=e2-custom-4-8192 --spot --image-type=UBUNTU_CONTAINERD \
  --disk-type=pd-standard --disk-size=40 --enable-dataplane-v2 --enable-ip-alias \
  --cluster-ipv4-cidr=10.40.0.0/14 --services-ipv4-cidr=10.44.0.0/20 \
  --labels="$labels" --node-labels="$labels" --service-account="$email" \
  --scopes=cloud-platform --logging=NONE --monitoring=NONE --no-enable-managed-prometheus \
  > "$BASKULE_K8S_EVIDENCE/cluster-create.log" 2>&1
gc container clusters get-credentials "$run_id" --zone="$zone" >/dev/null
kubectl wait --for=condition=Ready nodes --all --timeout=600s
kubectl get nodes -o json > "$state/nodes.private.json"
gc compute instances list --filter="labels.baskule-run=$run_id" --format=json > "$BASKULE_K8S_EVIDENCE/node-times.json"
gc compute addresses create "$run_id" --global --ip-version=IPV4 >/dev/null
gc compute addresses update "$run_id" --global --update-labels="$labels" >/dev/null
address=$(gc compute addresses describe "$run_id" --global --format='value(address)')
export BASKULE_K8S_PUBLIC_URL="http://$address.sslip.io"
kubectl create namespace "$run_id" >/dev/null
kubectl label namespace "$run_id" "$marker=true" "baskule-run=$run_id" >/dev/null
cat <<YAML | kubectl -n "$run_id" apply -f - >/dev/null
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata: {name: baskule}
spec:
  timeoutSec: 3600
  logging: {enable: true, sampleRate: 1}
  healthCheck: {type: HTTP, port: 47091, requestPath: /.well-known/celld/health}
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: baskule-ephemeral}
provisioner: pd.csi.storage.gke.io
parameters: {type: pd-balanced, labels: "$labels"}
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
YAML
export BASKULE_K8S_VALUES="$state/values.private.yaml"
cat > "$BASKULE_K8S_VALUES" <<YAML
rustfs: {storageClass: baskule-ephemeral}
openshell:
  server: {dataStorageClass: baskule-ephemeral, workspaceStorageClass: baskule-ephemeral}
exposure:
  mode: ingress
  serviceAnnotations:
    cloud.google.com/neg: '{"ingress":true}'
    cloud.google.com/backend-config: '{"default":"baskule"}'
  ingress:
    annotations:
      kubernetes.io/ingress.class: gce
      kubernetes.io/ingress.global-static-ip-name: $run_id
YAML
export BASKULE_K8S_CROSS_NODE=1 BASKULE_K8S_CHECK_INGRESS=1
bash e2e/kubernetes-install.sh > "$BASKULE_K8S_EVIDENCE/install.log" 2>&1
