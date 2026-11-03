---
paths: ["deploy/helm/**", "e2e/kubernetes*", "openshell/images/gateway-kubernetes/**", "scripts/helm-package.sh"]
profile: "custom"
checks: ["scripts/check kubernetes"]
---
# Kubernetes installation

The check creates its own kind cluster with Calico and Agent Sandbox, uses branch images,
runs a test-only RustFS fixture and installs the Helm chart with normal S3 values, and runs setup, fake streamed chat, computer exec,
PVC persistence and celld takeover. It removes the cluster on exit and keeps evidence
under `.run/evidence/kubernetes/`. Build images as described in
[the Kubernetes guide](../../../../docs/install-kubernetes.md) first.

`e2e/kubernetes-ephemeral.sh run` repeats the journey on zonal GKE Standard, including
a tagged Scaleway S3 bucket, cross-node PD reattachment and WebSocket streaming through GKE Ingress. It requires
the owner's explicit authorization, authenticated gcloud and `BASKULE_GKE_PROJECT`
matching the active project, plus private `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, and
`SCW_DEFAULT_PROJECT_ID` (Object Storage only). It is never selected by ordinary checks.
