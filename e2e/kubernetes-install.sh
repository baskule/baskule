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
chart_args=()
if [[ -n ${BASKULE_K8S_CHART_VERSION:-} ]]; then chart_args=(--version "$BASKULE_K8S_CHART_VERSION"); fi
values_args=()
if [[ -n ${BASKULE_K8S_VALUES:-} ]]; then values_args=(--values "$BASKULE_K8S_VALUES"); fi
# NOTES contains the private setup link. Keep Helm's output out of evidence.
helm upgrade --install "$BASKULE_K8S_RELEASE" "$chart" \
  "${chart_args[@]}" \
  --namespace "$BASKULE_K8S_NAMESPACE" --create-namespace --timeout 10m \
  --set-string publicUrl="$BASKULE_K8S_PUBLIC_URL" \
  --set-string global.image.registry="$registry" --set-string global.image.tag="$tag" \
  "${values_args[@]}" > /dev/null
kubectl -n "$BASKULE_K8S_NAMESPACE" rollout status statefulset/"$BASKULE_K8S_RELEASE-celld" --timeout=240s
if [[ ${BASKULE_K8S_JOURNEY:-full} == full ]]; then
  # Run the actual deployment command with setup still required, retaining this
  # test Job long enough to assert its logs without writing them to evidence.
  kubectl -n "$BASKULE_K8S_NAMESPACE" exec "$BASKULE_K8S_RELEASE-celld-0" -- \
    curl -fsS "http://$BASKULE_K8S_RELEASE/api/baskule/setup" | jq -e '.required == true' >/dev/null
  helm template "$BASKULE_K8S_RELEASE" "$chart" "${chart_args[@]}" --namespace "$BASKULE_K8S_NAMESPACE" \
    --show-only templates/deploy.yaml \
    --set-string publicUrl="$BASKULE_K8S_PUBLIC_URL" --set-string global.image.registry="$registry" \
    --set-string global.image.tag="$tag" "${values_args[@]}" | \
    kubectl -n "$BASKULE_K8S_NAMESPACE" create --dry-run=client -f - -o json | \
    jq '.metadata.name += "-log-proof" | del(.metadata.annotations)' | kubectl -n "$BASKULE_K8S_NAMESPACE" create -f - >/dev/null
  kubectl -n "$BASKULE_K8S_NAMESPACE" wait --for=condition=Complete "job/$BASKULE_K8S_RELEASE-deploy-log-proof" --timeout=240s
  node --input-type=module <<'JS'
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const namespace = process.env.BASKULE_K8S_NAMESPACE;
const release = process.env.BASKULE_K8S_RELEASE;
const secret = JSON.parse(execFileSync("kubectl", ["-n", namespace, "get", "secret", `${release}-secrets`, "-o", "json"], { encoding: "utf8" }));
const token = Buffer.from(secret.data.SETUP_TOKEN, "base64").toString();
const logs = execFileSync("kubectl", ["-n", namespace, "logs", `job/${release}-deploy-log-proof`], { encoding: "utf8" });
assert.ok(token.length > 0);
assert.equal(logs.includes(token) || logs.includes("token="), false, "deployment logs must not contain the setup token/link");
console.log("PASS required=true deployment logs contain no setup token");
JS
  kubectl -n "$BASKULE_K8S_NAMESPACE" delete job "$BASKULE_K8S_RELEASE-deploy-log-proof" --timeout=60s >/dev/null
fi
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
if [[ ${BASKULE_K8S_CHECK_INGRESS:-} == 1 ]]; then
  # GKE-only transport probe: the product WebSocket still uses the celld backend.
  kubectl -n "$BASKULE_K8S_NAMESPACE" annotate service fake-llm \
    'cloud.google.com/neg={"ingress":true}' 'cloud.google.com/backend-config={"default":"stream-probe"}' >/dev/null
  kubectl -n "$BASKULE_K8S_NAMESPACE" patch ingress "$BASKULE_K8S_RELEASE" --type=json \
    -p '[{"op":"add","path":"/spec/rules/0/http/paths/-","value":{"path":"/v1/chat/completions","pathType":"Exact","backend":{"service":{"name":"fake-llm","port":{"number":47601}}}}}]' >/dev/null
fi
if [[ ${BASKULE_K8S_JOURNEY:-full} != upgrade ]]; then
  node e2e/kubernetes-journey.mjs | tee "$BASKULE_K8S_EVIDENCE/journey.log"
fi
# Server-side rendering must apply newly supplied external credentials even when
# an existing S3 Secret was selected. No bucket or credential mutation is performed.
render=$(mktemp "$root/.run/s3-upgrade.XXXXXX.private.json")
helm upgrade "$BASKULE_K8S_RELEASE" "$chart" "${chart_args[@]}" --namespace "$BASKULE_K8S_NAMESPACE" \
  --reset-then-reuse-values --dry-run=server --output json \
  --set s3.existingSecret= --set s3.endpoint=https://s3.example.test --set s3.accessKeyId=review-access --set s3.secretAccessKey=review-secret > "$render"
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
s3_secret=$(kubectl -n "$BASKULE_K8S_NAMESPACE" get statefulset "$BASKULE_K8S_RELEASE-celld" -o json | jq -r '.spec.template.spec.containers[0].env[] | select(.name == "AWS_ACCESS_KEY_ID") | .valueFrom.secretKeyRef.name')
before=$(kubectl -n "$BASKULE_K8S_NAMESPACE" get secret "$BASKULE_K8S_RELEASE-secrets" "$s3_secret" -o json | jq -c '[.items[] | {name:.metadata.name,data}] | sort_by(.name)' | sha256sum)
helm upgrade "$BASKULE_K8S_RELEASE" "$chart" "${chart_args[@]}" --namespace "$BASKULE_K8S_NAMESPACE" --reset-then-reuse-values --timeout 10m --wait > /dev/null
after=$(kubectl -n "$BASKULE_K8S_NAMESPACE" get secret "$BASKULE_K8S_RELEASE-secrets" "$s3_secret" -o json | jq -c '[.items[] | {name:.metadata.name,data}] | sort_by(.name)' | sha256sum)
[[ $before == "$after" ]]
echo 'PASS Helm upgrade preserves generated platform tokens and keeps the supplied S3 Secret' | tee -a "$BASKULE_K8S_EVIDENCE/results.log"
kubectl -n "$BASKULE_K8S_NAMESPACE" get pods,pvc,networkpolicy > "$BASKULE_K8S_EVIDENCE/resources.txt"

# Exercise Helm's cross-version default merge without pulling fictitious images.
# Keep each packaged chart's real defaults and image helper; render only a ConfigMap.
(
  work=$(mktemp -d "$root/.run/helm-upgrade.XXXXXX")
  proof="$BASKULE_K8S_RELEASE-tag-proof"
  cleanup_tags() {
    helm uninstall "$proof" -n "$BASKULE_K8S_NAMESPACE" --no-hooks >/dev/null 2>&1 || true
    rm -rf "$work"
  }
  trap cleanup_tags EXIT
  for version in 1.0.0 2.0.0; do
    BASKULE_VERSION=$version scripts/helm-package.sh "$work" >/dev/null
    mkdir "$work/$version"
    tar -xzf "$work/baskule-$version.tgz" -C "$work/$version"
    fixture="$work/$version/baskule"
    cp "$fixture/templates/_helpers.tpl" "$work/helpers"
    rm -rf "$fixture/templates" "$fixture/charts"
    mkdir "$fixture/templates"
    mv "$work/helpers" "$fixture/templates/_helpers.tpl"
    # The rendering check uses the exact packaged Baskule defaults/helper.
    printf 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: {{ .Release.Name }}}\ndata:\n  image: {{ include "baskule.image" (dict "root" . "name" "celld") | quote }}\n' > "$fixture/templates/image.yaml"
    printf 'apiVersion: v2\nname: baskule\nversion: %s\nappVersion: "%s"\n' "$version" "$version" > "$fixture/Chart.yaml"
    helm package "$fixture" --destination "$work/$version" >/dev/null
  done
  helm install "$proof" "$work/1.0.0/baskule-1.0.0.tgz" --namespace "$BASKULE_K8S_NAMESPACE" --set s3.endpoint=https://s3.example.test --set s3.bucket=tag-proof --set s3.existingSecret=bucket >/dev/null
  helm upgrade "$proof" "$work/2.0.0/baskule-2.0.0.tgz" --namespace "$BASKULE_K8S_NAMESPACE" --reset-then-reuse-values >/dev/null
  image=$(kubectl -n "$BASKULE_K8S_NAMESPACE" get configmap "$proof" -o jsonpath='{.data.image}')
  [[ $image == ghcr.io/baskule/baskule-celld:2.0.0 ]]
  echo 'PASS packaged 1.0.0 -> 2.0.0 upgrade selects the new default image tag' | tee -a "$BASKULE_K8S_EVIDENCE/results.log"
)
