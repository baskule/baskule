# Deployment assets

Operators use [Install Baskule](../docs/install.md) or [Install a cluster](../docs/install-cluster.md).
Developers use [Build Baskule](../docs/building.md). These files describe the current Compose deployment.

| File | Purpose |
| --- | --- |
| `docker-compose.yml`, `.env.example` | Standalone single-machine release assets |
| `cluster/node.yml`, `node.env.example` | One platform node and an optional app deployment job |
| `cluster/computers.yml`, `computers.env.example` | One computers host, plus offline backup and restore jobs |
| `cluster/edge.yml`, `edge.env.example` | Optional HTTP edge for a node list |
| `docker-compose.build.yml` | Source-build override, selected by `lib.sh` |
| `celld/` | Shared node/job image containing Worker, web app, downloads, and deployment utilities |
| `build-env/` | Ubuntu 24.04 native build environment |
| `runner/` | Optional operator-managed runner tools |

Released images use `ghcr.io/baskule/baskule-{celld,computerd,computer,openshell-gateway,openshell-supervisor,openshell-sandbox}:VERSION`.
Third-party storage, edge, and trace images are pinned by digest in Compose. The gateway also embeds all three
workload images, so its private daemon needs no registry access or host image loader.

The single-machine stack has separate platform and computer networks. Only computerd joins both; the optional
trace collector also receives from both. Only edge HTTP and the optional trace UI are published. Cluster roles
bind Worker, peer, and computerd listeners on explicitly configured private addresses. Computer egress policy
continues to deny private destinations.

Default memory caps total 15.75 GiB: two nodes at 3 GiB each, RustFS at 1 GiB, edge at 256 MiB, computerd at
512 MiB, and OpenShell at 8 GiB. The optional trace collector adds 1 GiB. CPU caps are 2 per node, 1 for storage,
edge and computerd, and 3 for OpenShell. Each computer defaults to 2 CPU and 3 GiB within OpenShell's aggregate
cap. These limits are not reservations. Persistent volumes hold the bucket, node caches, gateway state, and private
Docker store containing computer disks.

`init-env.sh`, `up.sh`, `deploy.sh`, `down.sh`, `backup.sh`, and `recreate-computers.sh` serve the checkout-based
developer path. Operators need only the release files and Docker Compose. Release assembly uses
`scripts/release-install-assets.sh`; CI and publishing are documented in [Hosted checks and artifact builds](../docs/ci.md).
