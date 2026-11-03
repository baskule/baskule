#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
source scripts/env.sh
export PATH="$HOME/.local/bin:$PATH"
helm dependency build deploy/helm/baskule >/dev/null
if [[ ${1:-} == lint ]]; then
  helm lint deploy/helm/baskule --set rustfs.enabled=true --set openshell.agentSandbox.preflight.enabled=false
  helm template baskule deploy/helm/baskule --set rustfs.enabled=true --set openshell.agentSandbox.preflight.enabled=false >/dev/null
  helm template baskule deploy/helm/baskule --set s3.endpoint=https://s3.example.test --set s3.existingSecret=bucket --set existingSecret=platform --set publicUrl=https://baskule.example.test --set exposure.mode=ingress --set openshell.agentSandbox.preflight.enabled=false >/dev/null
  helm template baskule deploy/helm/baskule --set rustfs.enabled=true --set publicUrl=https://baskule.example.test --set exposure.mode=gateway --set exposure.gateway.name=edge --set openshell.agentSandbox.preflight.enabled=false >/dev/null
  for invalid in typo=true s3.typo=true global.image.typo=true exposure.mode=ingress exposure.mode=gateway; do
    if helm template baskule deploy/helm/baskule --set rustfs.enabled=true --set openshell.agentSandbox.preflight.enabled=false --set "$invalid" >/dev/null 2>&1; then
      echo "Expected chart schema to reject $invalid" >&2; exit 1
    fi
  done
  exit
fi
export BASKULE_K8S_EVIDENCE="$root/.run/evidence/kubernetes/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BASKULE_K8S_EVIDENCE"
cluster="baskule-k8s-$(date -u +%s)"
export KUBECONFIG="$BASKULE_K8S_EVIDENCE/kubeconfig.private"
umask 077
cleanup() {
  status=$?
  kubectl -n baskule get events --sort-by=.lastTimestamp > "$BASKULE_K8S_EVIDENCE/events.txt" 2>/dev/null || true
  kind delete cluster --name "$cluster" >> "$BASKULE_K8S_EVIDENCE/cleanup.log" 2>&1 || true
  rm -f "$KUBECONFIG"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$BASKULE_K8S_EVIDENCE/kind.yaml" <<'YAML'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking: {disableDefaultCNI: true}
nodes:
  - {role: control-plane}
  - {role: worker}
  - {role: worker}
YAML
# Do not --wait here: Ready depends on installing the CNI below.
kind create cluster --name "$cluster" --config "$BASKULE_K8S_EVIDENCE/kind.yaml" > "$BASKULE_K8S_EVIDENCE/cluster-create.log" 2>&1
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.31.0/manifests/calico.yaml > "$BASKULE_K8S_EVIDENCE/calico-install.log"
kubectl wait --for=condition=Ready nodes --all --timeout=180s
registry=${BASKULE_K8S_REGISTRY:-ghcr.io/baskule-kubernetes-test}
export BASKULE_K8S_REGISTRY="$registry"
export BASKULE_K8S_TAG=${BASKULE_K8S_TAG:-kubernetes}
for name in celld computerd openshell-kubernetes computer openshell-supervisor openshell-sandbox; do
  docker tag "baskule-$name:$BASKULE_K8S_TAG" "$registry/baskule-$name:$BASKULE_K8S_TAG"
  kind load docker-image --name "$cluster" --nodes "$cluster-worker,$cluster-worker2" "$registry/baskule-$name:$BASKULE_K8S_TAG" >> "$BASKULE_K8S_EVIDENCE/image-load.log" 2>&1
done
# Hosted CI has two CPUs; keep room for the control plane and celld. These
# functional checks do not need the production computer's full resource limits.
if [[ -z ${BASKULE_K8S_VALUES:-} ]]; then
  export BASKULE_K8S_VALUES="$BASKULE_K8S_EVIDENCE/values.yaml"
  printf 'computer:\n  cpu: "1"\n  memory: 1Gi\n' > "$BASKULE_K8S_VALUES"
fi
bash e2e/kubernetes-install.sh
