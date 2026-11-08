---
paths: ["deploy/helm/**", "e2e/kubernetes*", "scripts/helm-package.sh"]
profile: "custom"
checks: ["scripts/check kubernetes"]
---
# Kubernetes installation

## Sub-features

Helm installation and upgrades, streamed fake chat, computer execution, PVC persistence,
network isolation, and celld takeover.

## Open the feature

Build the branch images as described in the
[Kubernetes guide](../../../../docs/install-kubernetes.md#verify-a-source-change).
The check creates its own disposable kind cluster and application installation.

## Verification

Run `scripts/check feature:kubernetes`. The check installs Calico and Agent Sandbox,
runs a test-only RustFS fixture outside the Helm chart, and installs the chart with
normal S3 values. It removes the cluster on exit and keeps diagnostics under
`.run/evidence/kind/<timestamp>/`.

## Gotchas

The local PVC fixture stays on one node and does not prove external CSI snapshot restore.
If a port is busy, identify the process using it; never stop another run or worktree to free it.
