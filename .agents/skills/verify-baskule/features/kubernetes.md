---
paths: ["deploy/helm/**", "e2e/kubernetes*", "scripts/helm-package.sh"]
profile: "custom"
checks: ["scripts/check kubernetes"]
---
# Kubernetes installation

The check creates its own kind cluster with Calico and Agent Sandbox, uses branch images,
installs the Helm chart with RustFS, and runs setup, fake streamed chat, computer exec,
PVC persistence and celld takeover. It removes the cluster on exit and keeps evidence
under `.run/evidence/kind/<timestamp>/`. Build images as described in
[the Kubernetes guide](../../../../docs/install-kubernetes.md) first.

`e2e/kubernetes-ephemeral.sh run` repeats the journey on zonal GKE Standard, including
cross-node PD reattachment and WebSocket streaming through GKE Ingress. It requires
the owner's explicit authorization, authenticated gcloud and `BASKULE_GKE_PROJECT`
matching the active project. It is never selected by ordinary checks.
