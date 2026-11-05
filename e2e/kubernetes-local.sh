#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
source scripts/env.sh
export BASKULE_K8S_NAMESPACE=${BASKULE_K8S_NAMESPACE:-baskule}
export BASKULE_K8S_RELEASE=${BASKULE_K8S_RELEASE:-baskule}
export PATH="$HOME/.local/bin:$PATH"
if [[ ${1:-} == lint ]]; then
  s3=(--set s3.endpoint=https://s3.example.test --set s3.bucket=test --set s3.existingSecret=bucket)
  helm lint deploy/helm/baskule "${s3[@]}"
  helm template baskule deploy/helm/baskule "${s3[@]}" >/dev/null
  helm template baskule deploy/helm/baskule --set s3.endpoint=https://s3.example.test --set s3.bucket=test --set s3.accessKeyId=test --set s3.secretAccessKey=test >/dev/null
  helm template baskule deploy/helm/baskule "${s3[@]}" --set existingSecret=platform --set publicUrl=https://baskule.example.test --set exposure.mode=ingress >/dev/null
  helm template baskule deploy/helm/baskule "${s3[@]}" --set publicUrl=https://baskule.example.test --set exposure.mode=gateway --set exposure.gateway.name=edge >/dev/null
  for invalid in connectUrl=http://relay.example.test connectUrl=http://127.0.0.1:8787 typo=true rustfs.enabled=true s3.typo=true global.image.typo=true exposure.mode=ingress exposure.mode=gateway s3.endpoint= s3.bucket= s3.existingSecret=; do
    if helm template baskule deploy/helm/baskule "${s3[@]}" --set exposure.gateway.name=edge --set "$invalid" >/dev/null 2>&1; then
      echo "Expected chart schema to reject $invalid" >&2; exit 1
    fi
  done
  if helm template baskule deploy/helm/baskule >/dev/null 2>&1; then
    echo 'Expected chart rendering to reject missing S3 configuration' >&2; exit 1
  fi
  for invalid_url in http://0.0.0.0 http://[::] http://LOCALHOST; do
    for mode in ingress gateway; do
      if helm template baskule deploy/helm/baskule "${s3[@]}" --set exposure.gateway.name=edge --set exposure.mode="$mode" --set-string publicUrl="$invalid_url" >/dev/null 2>&1; then
        echo "Expected chart schema to reject $invalid_url for $mode" >&2; exit 1
      fi
    done
  done
  exit
fi
export BASKULE_K8S_EVIDENCE="${BASKULE_K8S_EVIDENCE:-$root/.run/evidence/kind/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$BASKULE_K8S_EVIDENCE"
cluster="baskule-k8s-$(date -u +%s)"
export KUBECONFIG="$BASKULE_K8S_EVIDENCE/kubeconfig.private"
umask 077
cleanup() {
  status=$?
  kubectl -n "$BASKULE_K8S_NAMESPACE" get events --sort-by=.lastTimestamp > "$BASKULE_K8S_EVIDENCE/events.txt" 2>/dev/null || true
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
for name in celld computerd computer; do
  docker tag "baskule-$name:$BASKULE_K8S_TAG" "$registry/baskule-$name:$BASKULE_K8S_TAG"
  kind load docker-image --name "$cluster" --nodes "$cluster-worker,$cluster-worker2" "$registry/baskule-$name:$BASKULE_K8S_TAG" >> "$BASKULE_K8S_EVIDENCE/image-load.log" 2>&1
done
# Hosted CI has two CPUs; keep room for the control plane and celld. These
# functional checks do not need the production computer's full resource limits.
if [[ -z ${BASKULE_K8S_VALUES:-} ]]; then
  export BASKULE_K8S_VALUES="$BASKULE_K8S_EVIDENCE/values.yaml"
  printf 'computers:\n  cpus: "1"\n  memory: 1Gi\n' > "$BASKULE_K8S_VALUES"
fi
# Test-only S3 fixture. It is never part of the Helm chart/package.
kubectl create namespace "$BASKULE_K8S_NAMESPACE" >/dev/null
python3 - <<'PYFIXTURE' | kubectl -n "$BASKULE_K8S_NAMESPACE" apply -f - >/dev/null
import os
from pathlib import Path
print(Path('e2e/kubernetes-rustfs.yaml').read_text().replace('${BASKULE_K8S_RELEASE}', os.environ['BASKULE_K8S_RELEASE']))
PYFIXTURE
kubectl -n "$BASKULE_K8S_NAMESPACE" rollout status deployment/rustfs-fixture --timeout=180s
kubectl -n "$BASKULE_K8S_NAMESPACE" run fixture-bucket --restart=Never --image="$registry/baskule-celld:$BASKULE_K8S_TAG" \
  --env=AWS_ACCESS_KEY_ID=baskule-kind-test --env=AWS_SECRET_ACCESS_KEY=baskule-kind-test-secret \
  --env=AWS_REGION=us-east-1 --env=S3_ENDPOINT=http://rustfs-fixture:3900 \
  --env=CELLD_BUCKET_NAME=baskule-test --labels="app.kubernetes.io/instance=$BASKULE_K8S_RELEASE,app.kubernetes.io/component=deploy" \
  --command -- baskule-celld-job bootstrap >/dev/null
kubectl -n "$BASKULE_K8S_NAMESPACE" wait --for=jsonpath='{.status.phase}'=Succeeded pod/fixture-bucket --timeout=120s
cat >> "$BASKULE_K8S_VALUES" <<'YAML'
s3:
  endpoint: http://rustfs-fixture:3900
  region: us-east-1
  bucket: baskule-test
  existingSecret: rustfs-fixture
YAML
export BASKULE_K8S_S3_FIXTURE=rustfs-fixture
bash e2e/kubernetes-install.sh
