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
protect_young_runs=false
state_root="$root/.run/kubernetes-ephemeral"
lock_root=$(git rev-parse --path-format=absolute --git-common-dir)
mkdir -p "$state_root"
umask 077
state=$(mktemp -d "$state_root/gke.XXXXXX")
printf '%s' "$project" > "$state/project.private"
printf '[]' > "$state/owned-links.private.json"
printf '[]' > "$state/known-accounts.private.json"
for previous in "$state_root"/gke.*; do
  [[ -f $previous/project.private && $(cat "$previous/project.private") == "$project" && -f $previous/known-accounts.private.json ]] || continue
  jq -e 'type == "array" and all(.[]; type == "string")' "$previous/known-accounts.private.json" >/dev/null
  jq -s 'add | unique' "$state/known-accounts.private.json" "$previous/known-accounts.private.json" > "$state/accounts.next"
  mv "$state/accounts.next" "$state/known-accounts.private.json"
done
gc() { gcloud --project="$project" --quiet "$@"; }
# IAM cleanup is idempotent. Retry quota responses without hiding other failures.
iam_gc() {
  (cd e2e && node --input-type=module - "$project" "$@" <<'JS'
import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";
const [project, ...args] = process.argv.slice(2);
let output = "";
await expect.poll(() => {
  try {
    output = execFileSync("bash", ["-c", 'gcloud "$@"', "gcloud", `--project=${project}`, "--quiet", ...args], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    const message = String(error.stderr);
    if (/Policy binding .* not found/.test(message)) return true;
    if (/\b429\b|RESOURCE_EXHAUSTED/.test(message)) return false;
    throw error;
  }
}, { timeout: 90_000, message: "IAM cleanup quota becomes available" }).toBe(true);
process.stdout.write(output);
JS
  )
}
project_bindings() {
  jq -r --slurpfile known "$state/known-accounts.private.json" '
    .bindings[]? | .role as $role | .members[] as $member |
    select($member | startswith("serviceAccount:") or startswith("deleted:serviceAccount:")) |
    ($member | split("serviceAccount:")[1] | split("?")[0]) as $email |
    select($known[0] | index($email)) | [$role, $member] | @tsv' "$state/iam.private.json"
}
owned_filter='def label_match:
  (.labels // .resourceLabels // {}) as $labels |
  if $marker == "baskule-ephemeral" then
    $labels["baskule-ephemeral"] == "true" and ($labels["baskule-run"] // "") != ""
  else $labels["baskule-run"] == $marker end;
def description_match:
  (.description // "") as $text | any($runs[0][]; . as $run | $text | contains($run));
def labelled:
  ["clusters", "repositories", "instances", "disks", "forwarding-rules", "addresses"] | index($kind) != null;
def unlabelled_lb:
  ["target-http-proxies", "target-https-proxies", "url-maps", "backend-services", "target-pools", "health-checks", "http-health-checks", "https-health-checks", "network-endpoint-groups"] | index($kind) != null;
def marked:
  if labelled then label_match
  elif $kind == "accounts" then
    (.email as $email | $accounts[0] | index($email)) != null
  elif unlabelled_lb then
    ([.description, .name] | map(select(type == "string")) | join(" ")) as $text |
    any($runs[0][]; . as $run | $text | contains($run))
  else false end;
def selected:
  marked or
  ($kind == "forwarding-rules" and
    (description_match or ((.IPAddress // "") as $ip | $ip != "" and any($addresses[0][] | select(label_match); .address == $ip)))) or
  (unlabelled_lb and (.selfLink as $url | $links[0] | index($url)) != null);
'

kinds=(instances disks forwarding-rules target-http-proxies target-https-proxies url-maps backend-services target-pools health-checks http-health-checks https-health-checks addresses network-endpoint-groups firewall-rules)
inventory() {
  jq -e 'type == "array"' "$state/owned-links.private.json" >/dev/null || return
  gc container clusters list --format=json > "$state/clusters.private.json" || return
  gc artifacts repositories list --location=all --format=json > "$state/repositories.private.json" || return
  if [[ $protect_young_runs == true ]]; then guard_recent_runs || return; fi
  gc iam service-accounts list --format=json > "$state/accounts.private.json" || return
  local kind inputs=("$state/clusters.private.json" "$state/repositories.private.json" "$state/accounts.private.json")
  for kind in "${kinds[@]}"; do
    if [[ $kind == instances ]]; then
      gc compute "$kind" list --format='json(name,zone,labels,selfLink)' > "$state/$kind.private.json" || return
    else
      gc compute "$kind" list --format=json > "$state/$kind.private.json" || return
    fi
    inputs+=("$state/$kind.private.json")
  done
  jq -s --arg marker "${resource_scope:-$marker}" --slurpfile accounts "$state/known-accounts.private.json" '
    (if all(.[]; type == "array") then flatten else error("Resource inventory must contain arrays") end) as $resources |
    ([$resources[] | (.labels // .resourceLabels // {}) | select(.["baskule-ephemeral"] == "true") | .["baskule-run"]] +
     [$accounts[0][] | capture("^bk-(?<id>[0-9]+-[a-f0-9]{4})@").id | "baskule-ephemeral-" + .]) |
    map(select(type == "string" and test("^baskule-ephemeral-[0-9]+-[a-f0-9]{4}$"))) |
    unique | if $marker == "baskule-ephemeral" then . else map(select(. == $marker)) end
  ' "${inputs[@]}" > "$state/runs.private.json" || return
  # Follow only references rooted in labelled resources or saved run ownership.
  # Labelled kinds use labels; forwarding rules also recover through their owned IP or run description.
  for kind in clusters repositories accounts "${kinds[@]}"; do
    jq --arg marker "${resource_scope:-$marker}" --arg kind "$kind" --arg project "$project" \
      --slurpfile accounts "$state/known-accounts.private.json" --slurpfile runs "$state/runs.private.json" \
      --slurpfile links "$state/owned-links.private.json" --slurpfile addresses "$state/addresses.private.json" "$owned_filter"'
      [.[] | select(selected) | .. | strings | select(contains("/projects/" + $project + "/"))] + $links[0] | unique
    ' "$state/$kind.private.json" > "$state/links.next" || return
    mv "$state/links.next" "$state/owned-links.private.json"
  done
}
owned() {
  jq -r --arg marker "${resource_scope:-$marker}" --arg kind "$kind" \
    --slurpfile accounts "$state/known-accounts.private.json" --slurpfile runs "$state/runs.private.json" \
    --slurpfile links "$state/owned-links.private.json" --slurpfile addresses "$state/addresses.private.json" "$owned_filter"'.[] | select(selected) | [.name, (.location // .zone // .region // "global" | split("/") | last)] | @tsv'
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
  if [[ $(jq length "$state/known-accounts.private.json") != 0 ]]; then
    iam_gc projects get-iam-policy "$project" --format=json > "$state/iam.private.json" || return
    count=$(project_bindings | wc -l) || return
    printf 'iam-bindings: %s owned references (including deleted accounts)\n' "$count"
    remaining=$((remaining + count))
  fi
  (( remaining == 0 ))
}
sweep() {
  inventory || return
  local name location kind flag email role member
  while read -r name location; do gc container clusters delete "$name" --zone="$location" || true; done < <(kind=clusters owned < "$state/clusters.private.json")
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
  while read -r name; do gc artifacts repositories delete "$name" --location="$region" || true; done < <(kind=repositories owned < "$state/repositories.private.json" | cut -f1 | sed 's|.*/||')
  if [[ $(jq length "$state/known-accounts.private.json") != 0 ]]; then
    iam_gc projects get-iam-policy "$project" --format=json > "$state/iam.private.json" || return
    project_bindings > "$state/iam-bindings.private.tsv" || return
    while read -r role member; do
      iam_gc projects remove-iam-policy-binding "$project" --member="$member" --role="$role" --condition=None >/dev/null || return
    done < "$state/iam-bindings.private.tsv"
  fi
  # Do not delete an identity while removing its project grant is unconfirmed.
  while read -r email; do
    gc iam service-accounts delete "$email" || true
  done < <(jq -r --slurpfile known "$state/known-accounts.private.json" '.[] | .email as $email | select($known[0] | index($email)) | $email' "$state/accounts.private.json")
  audit
}
guard_recent_runs() {
  python3 - "$state/clusters.private.json" "$state/repositories.private.json" <<'PYGUARD'
import json, sys
from datetime import datetime, timezone
now = datetime.now(timezone.utc)
for filename in sys.argv[1:]:
    for resource in json.load(open(filename)):
        labels = resource.get('resourceLabels') or resource.get('labels', {})
        if labels.get('baskule-ephemeral') != 'true':
            continue
        try:
            age = (now - datetime.fromisoformat(resource['createTime'].replace('Z', '+00:00'))).total_seconds()
        except (KeyError, ValueError, TypeError):
            age = -1  # Unknown age cannot establish that the run has expired.
        if age < 120 * 60:
            sys.exit('Refuse global sweep: a labelled cluster or repository is younger than 120 minutes or has unknown age; use --force only for deliberate recovery')
PYGUARD
}
case "${1:-}" in
  sweep|audit)
    if [[ $1 == sweep && ${2:-} != --force ]]; then
      exec 9> "$lock_root/baskule-gke-$project.lock"
      flock -n 9 || { echo 'Live run exists in this repository; refuse global sweep (use --force only to interrupt it)' >&2; exit 1; }
      protect_young_runs=true
    fi
    # Recover saved ownership from interrupted runs, confined to this project.
    for previous in "$state_root"/gke.*; do
      [[ -f $previous/project.private && $(cat "$previous/project.private") == "$project" && -f $previous/owned-links.private.json ]] || continue
      jq -e 'type == "array"' "$previous/owned-links.private.json" >/dev/null || exit 1
      jq -s 'add | unique' "$state/owned-links.private.json" "$previous/owned-links.private.json" > "$state/links.next"
      mv "$state/links.next" "$state/owned-links.private.json"
    done
    "$1"; exit ;;
  # Snapshot into bash's input string so edits cannot change an in-flight run.
  run) exec timeout --signal=TERM --kill-after=30m 90m bash -c "$(cat "$0")" "$0" worker ;;
  worker)
    exec 9> "$lock_root/baskule-gke-$project.lock"
    flock -n 9 || { echo 'Live run exists; refuse another worker' >&2; exit 1; }
    ;;
  *) echo "Usage: $0 run|sweep [--force]|audit" >&2; exit 2 ;;
esac
run_id="$marker-$(date -u +%s)-$(od -An -N2 -tx1 /dev/urandom | tr -d '[:space:]')"
labels="$marker=true,baskule-run=$run_id"
export BASKULE_K8S_EVIDENCE="$root/.run/evidence/$run_id"
export KUBECONFIG="$state/kubeconfig.private" DOCKER_CONFIG="$state/docker.private"
export HELM_REGISTRY_CONFIG="$DOCKER_CONFIG/config.json"
export BASKULE_K8S_NAMESPACE="$run_id" BASKULE_K8S_RELEASE=baskule
mkdir -p "$BASKULE_K8S_EVIDENCE" "$DOCKER_CONFIG"
started=$(date +%s)
nodes_started=0
cleanup() {
  status=$?
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  inventory
  while read -r name location; do
    gc logging read "resource.type=\"http_load_balancer\" AND resource.labels.forwarding_rule_name=\"$name\" AND httpRequest.status>=500" \
      --limit=20 --freshness=2h --format=json > "$state/$name.lb-errors.private.json"
  done < <(kind=forwarding-rules owned < "$state/forwarding-rules.private.json")
  # The CLI's labels flag uses the gated alpha API; use the stable setLabels API.
  python3 - "$project" "$run_id" "$state/forwarding-rules.private.json" "$state/addresses.private.json" <<'PY'
import json, subprocess, sys, urllib.request
project, run, inventory, addresses = sys.argv[1:]
# Match the exact reserved address owned by this run, never a name substring.
owned_ips = {a['address'] for a in json.load(open(addresses)) if a.get('labels', {}).get('baskule-run') == run}
rules = [r for r in json.load(open(inventory)) if r.get('IPAddress') in owned_ips]
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
    # Bound the entire Kubernetes phase; cluster deletion below is unconditional.
    timeout --signal=TERM --kill-after=30s 8m bash -c '
      trap - INT TERM HUP
      run_id=$1; state=$2; evidence=$3
      kubectl --request-timeout=20s -n "$run_id" get pods -o json > "$state/pods.private.json"
      while read -r pod; do
        kubectl --request-timeout=20s -n "$run_id" logs "$pod" --all-containers > "$state/$pod.private.log" 2>&1
      done < <(jq -r ".items[].metadata.name" "$state/pods.private.json")
      kubectl --request-timeout=20s -n "$run_id" get events --sort-by=.lastTimestamp > "$evidence/events.txt" 2>/dev/null
      kubectl --request-timeout=20s -n "$run_id" delete ingress --all --timeout=120s >/dev/null
      kubectl --request-timeout=20s -n "$run_id" delete sandboxes --all --timeout=90s >/dev/null
      helm uninstall baskule -n "$run_id" --wait --timeout 90s >/dev/null
      kubectl --request-timeout=20s -n "$run_id" delete pvc --all --timeout=90s >/dev/null
    ' bash "$run_id" "$state" "$BASKULE_K8S_EVIDENCE" || echo 'Kubernetes cleanup incomplete; continuing cluster deletion. Run sweep after timeout.' >&2
  fi
  # Attempt known resource deletion even if an inventory API was unavailable.
  gc container clusters delete "$run_id" --zone="$zone" >/dev/null 2>&1
  gc artifacts repositories delete "$run_id" --location="$region" >/dev/null 2>&1
  gc compute addresses delete "$run_id" --global >/dev/null 2>&1
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
jq -n --arg email "bk-${run_id#baskule-ephemeral-}@$project.iam.gserviceaccount.com" '[$email]' > "$state/known-accounts.private.json"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$state/before"
cp "$state/"*.private.json "$state/before/"
BASKULE_VERSION=0.0.0-ephemeral scripts/helm-package.sh "$BASKULE_K8S_EVIDENCE" > "$BASKULE_K8S_EVIDENCE/chart-package.log"
export BASKULE_K8S_CHART="$BASKULE_K8S_EVIDENCE/baskule-0.0.0-ephemeral.tgz"
command -v docker-credential-gcloud >/dev/null
# Both clients renew credentials through the existing SDK identity. Do not cache
# a possibly near-expiry access token for the whole 90-minute run.
jq -n --arg host "$region-docker.pkg.dev" '{credHelpers:{($host):"gcloud"}}' > "$HELM_REGISTRY_CONFIG"
gc artifacts repositories create "$run_id" --location="$region" --repository-format=docker --labels="$labels" > "$BASKULE_K8S_EVIDENCE/registry-create.log" 2>&1
export BASKULE_K8S_REGISTRY="$region-docker.pkg.dev/$project/$run_id"
helm push "$BASKULE_K8S_CHART" "oci://$BASKULE_K8S_REGISTRY" > "$BASKULE_K8S_EVIDENCE/chart-push.log" 2>&1
export BASKULE_K8S_CHART="oci://$BASKULE_K8S_REGISTRY/baskule"
export BASKULE_K8S_CHART_VERSION=0.0.0-ephemeral
export BASKULE_K8S_TAG=${BASKULE_K8S_TAG:-kubernetes}
for name in celld computerd computer; do
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
# IAM policy readers can lag a successful service-account creation. Retry only
# that propagation error; authorization and other failures remain fatal.
(cd e2e && node --input-type=module - "$project" "$email" "$run_id" "$region" <<'JS'
import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";
const [project, email, repository, region] = process.argv.slice(2);
for (const args of [
  ["projects", "add-iam-policy-binding", project, `--member=serviceAccount:${email}`, "--role=roles/container.defaultNodeServiceAccount", "--condition=None"],
  ["artifacts", "repositories", "add-iam-policy-binding", repository, `--location=${region}`, `--member=serviceAccount:${email}`, "--role=roles/artifactregistry.reader"],
]) {
  await expect.poll(() => {
    try { execFileSync("gcloud", [`--project=${project}`, "--quiet", ...args], { stdio: ["ignore", "ignore", "pipe"] }); return true; }
    catch (error) {
      if (/Service account .* does not exist/.test(String(error.stderr))) return false;
      throw error;
    }
  }, { timeout: 90_000, message: "new node service account propagates to IAM" }).toBe(true);
}
JS
)
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
kubectl --request-timeout=30s wait --for=condition=Ready nodes --all --timeout=600s
kubectl --request-timeout=30s get nodes -o json > "$state/nodes.private.json"
gc compute instances list --filter="labels.baskule-run=$run_id" --format='json(selfLink,creationTimestamp)' > "$BASKULE_K8S_EVIDENCE/node-times.json"
gc compute addresses create "$run_id" --global --ip-version=IPV4 >/dev/null
gc compute addresses update "$run_id" --global --update-labels="$labels" >/dev/null
address=$(gc compute addresses describe "$run_id" --global --format='value(address)')
export BASKULE_K8S_PUBLIC_URL="http://$address.sslip.io"
kubectl --request-timeout=30s create namespace "$run_id" >/dev/null
kubectl --request-timeout=30s label namespace "$run_id" "$marker=true" "baskule-run=$run_id" >/dev/null
cat <<YAML | kubectl --request-timeout=30s -n "$run_id" apply -f - >/dev/null
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata: {name: baskule}
spec:
  timeoutSec: 3600
  logging: {enable: true, sampleRate: 1}
  healthCheck: {type: HTTP, port: 47091, requestPath: /.well-known/celld/health}
---
# Reuse the existing fake LLM for an independent HTTP streaming transport probe.
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata: {name: stream-probe}
spec:
  timeoutSec: 3600
  healthCheck: {type: HTTP, port: 47601, requestPath: /health}
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
computers:
  storageClass: baskule-ephemeral
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
