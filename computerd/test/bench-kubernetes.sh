#!/usr/bin/env bash
set -euo pipefail
namespace=${BASKULE_K8S_NAMESPACE:?}
release=${BASKULE_K8S_RELEASE:-baskule}
out=${BENCH_OUT:?}
kubectl -n "$namespace" rollout status deployment/"$release-computerd" --timeout=180s
pod=$(kubectl -n "$namespace" get pod -l "app.kubernetes.io/component=computerd" -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$namespace" exec "$pod" -- sh -c 'mkdir -p /tmp/baskule-bench; ln -sfn /app/node_modules /tmp/baskule-bench/node_modules'
for file in bench.ts client.ts; do
  kubectl -n "$namespace" exec -i "$pod" -- sh -c "cat > /tmp/baskule-bench/$file" < "computerd/test/$file"
done
kubectl -n "$namespace" exec "$pod" -- env COMPUTERD_URL=http://127.0.0.1:47094 BENCH_RUNS="${BENCH_RUNS:-3}" node /tmp/baskule-bench/bench.ts > "$out"
