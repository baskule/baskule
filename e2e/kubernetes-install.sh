#!/usr/bin/env bash
# Shared install and journey used by kind and the authorized ephemeral cloud run.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
source scripts/env.sh
export BASKULE_K8S_NAMESPACE=${BASKULE_K8S_NAMESPACE:-baskule}
export BASKULE_K8S_RELEASE=${BASKULE_K8S_RELEASE:-baskule}
export BASKULE_K8S_EVIDENCE=${BASKULE_K8S_EVIDENCE:-$root/.run/evidence/kubernetes}
if [[ -z ${BASKULE_K8S_PUBLIC_URL:-} ]]; then
  port=$(node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  export BASKULE_K8S_PUBLIC_URL="http://127.0.0.1:$port"
fi
registry=${BASKULE_K8S_REGISTRY:-ghcr.io/baskule-kubernetes-test}
tag=${BASKULE_K8S_TAG:-kubernetes}
mkdir -p "$BASKULE_K8S_EVIDENCE"
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.9/sandbox.yaml > "$BASKULE_K8S_EVIDENCE/agent-sandbox-install.log"
kubectl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
chart=${BASKULE_K8S_CHART:-deploy/helm/baskule}
if [[ -d $chart ]]; then helm dependency build "$chart" >/dev/null; fi
chart_args=()
if [[ -n ${BASKULE_K8S_CHART_VERSION:-} ]]; then chart_args=(--version "$BASKULE_K8S_CHART_VERSION"); fi
values_args=()
if [[ -n ${BASKULE_K8S_VALUES:-} ]]; then values_args=(--values "$BASKULE_K8S_VALUES"); fi
# NOTES contains the private setup link. Keep Helm's output out of evidence.
helm upgrade --install "$BASKULE_K8S_RELEASE" "$chart" \
  "${chart_args[@]}" \
  --namespace "$BASKULE_K8S_NAMESPACE" --create-namespace --timeout 10m \
  --set rustfs.enabled=true --set-string publicUrl="$BASKULE_K8S_PUBLIC_URL" \
  --set-string global.image.registry="$registry" --set-string global.image.tag="$tag" \
  "${values_args[@]}" > /dev/null
kubectl -n "$BASKULE_K8S_NAMESPACE" rollout status statefulset/"$BASKULE_K8S_RELEASE-celld" --timeout=240s
kubectl -n "$BASKULE_K8S_NAMESPACE" rollout status statefulset/"$BASKULE_K8S_RELEASE-openshell" --timeout=180s
kubectl -n "$BASKULE_K8S_NAMESPACE" create configmap fake-llm --from-file=server.mjs=platform/dev/fake-llm/server.mjs --dry-run=client -o yaml | kubectl apply -f - >/dev/null
cat <<YAML | kubectl -n "$BASKULE_K8S_NAMESPACE" apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: {name: fake-llm}
spec:
  replicas: 1
  selector: {matchLabels: {app: fake-llm}}
  template:
    metadata: {labels: {app: fake-llm}}
    spec:
      automountServiceAccountToken: false
      containers:
        - name: fake-llm
          image: $registry/baskule-computerd:$tag
          command: [node, /fake/server.mjs, --host, 0.0.0.0, --port, "47601"]
          volumeMounts: [{name: script, mountPath: /fake/server.mjs, subPath: server.mjs, readOnly: true}]
          readinessProbe: {httpGet: {path: /health, port: 47601}}
      volumes: [{name: script, configMap: {name: fake-llm}}]
---
apiVersion: v1
kind: Service
metadata: {name: fake-llm}
spec:
  selector: {app: fake-llm}
  ports: [{port: 47601}]
YAML
kubectl -n "$BASKULE_K8S_NAMESPACE" rollout status deployment/fake-llm --timeout=180s
node e2e/kubernetes-journey.mjs | tee "$BASKULE_K8S_EVIDENCE/journey.log"
# Server-side rendering must apply newly supplied external credentials even when
# the old evaluation Secret exists. No bucket or credential mutation is performed.
render=$(mktemp "$root/.run/s3-upgrade.XXXXXX.private.json")
helm upgrade "$BASKULE_K8S_RELEASE" "$chart" "${chart_args[@]}" --namespace "$BASKULE_K8S_NAMESPACE" \
  --reuse-values --dry-run=server --output json --set rustfs.enabled=false \
  --set s3.endpoint=https://s3.example.test --set s3.accessKeyId=review-access --set s3.secretAccessKey=review-secret > "$render"
node --input-type=module - "$render" "$BASKULE_K8S_RELEASE" <<'JS'
import { readFileSync, unlinkSync } from "node:fs";
import assert from "node:assert/strict";
const [file, release] = process.argv.slice(2);
try {
  const manifests = JSON.parse(readFileSync(file, "utf8")).manifest.split("---");
  const secret = manifests.find(doc => doc.includes(`name: ${release}-s3\n`));
  for (const value of ["review-access", "review-secret"]) assert.ok(secret?.includes(Buffer.from(value).toString("base64")));
} finally { unlinkSync(file); }
JS
echo 'PASS server-side upgrade rendering applies changed external S3 credentials' | tee -a "$BASKULE_K8S_EVIDENCE/results.log"
# Real lookup must retain token bytes on an upgrade. Compare hashes, never dump Secrets.
before=$(kubectl -n "$BASKULE_K8S_NAMESPACE" get secret "$BASKULE_K8S_RELEASE-secrets" -o jsonpath='{.data}' | sha256sum)
helm upgrade "$BASKULE_K8S_RELEASE" "$chart" "${chart_args[@]}" --namespace "$BASKULE_K8S_NAMESPACE" --reuse-values --timeout 10m --wait > /dev/null
after=$(kubectl -n "$BASKULE_K8S_NAMESPACE" get secret "$BASKULE_K8S_RELEASE-secrets" -o jsonpath='{.data}' | sha256sum)
[[ $before == "$after" ]]
echo 'PASS Helm upgrade preserves generated tokens' | tee -a "$BASKULE_K8S_EVIDENCE/results.log"
kubectl -n "$BASKULE_K8S_NAMESPACE" get pods,pvc,networkpolicy > "$BASKULE_K8S_EVIDENCE/resources.txt"
