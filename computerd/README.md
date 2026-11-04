# computerd

Stateless HTTP service connecting celld to space computers. [Backend](src/backend.ts)
defines lifecycle, exec and port connections; [DockerBackend](src/docker.ts) serves
Compose and development, and [KubernetesBackend](src/kubernetes.ts) serves Helm installs.
Computer disks mount at `/sandbox/space` and survive stop/start. Deletion removes both
machine and disk. Activity and keep flags are held in memory; idle computers stop.

## Docker

DockerBackend talks to Docker Engine over its Unix socket. Computers run as 1000:1000
on the `baskule-computers` bridge with inter-container communication disabled,
CapDrop ALL, no-new-privileges and PidsLimit 1024. Each uses a named
`baskule-space-<suffix>` volume. Exec uses Docker's hijacked stream; port connections
use a relay inside the computer.

[The guard](src/guard.ts) installs DROP rules in DOCKER-USER, INPUT for host addresses,
and FORWARD mirrors so earlier Tailscale-style accepts cannot bypass them. It blocks
private, link-local, CGNAT, loopback, multicast and reserved destinations. Rules carry
`baskule-computer-guard:<subnet>` tags. A short-lived helper from the computerd image
runs with host networking and NET_ADMIN. Rules reconcile at startup and every 60 seconds.
If verification fails, ensure returns HTTP 503 without creating a computer.
Docker using only nftables is unsupported. Public DNS defaults avoid blocked private upstreams.

## Kubernetes

The backend uses agent-sandbox v1.0.9 `Sandbox` objects (`agents.x-k8s.io/v1beta1`).
A volumeClaimTemplate creates PVC `<disk>-<sandbox>` at `/sandbox/space`.
`operatingMode` controls suspend/resume. Exec uses the Kubernetes API WebSocket
`v5.channel.k8s.io`; port connections use API port-forwarding. Pods run as non-root
1000, drop ALL capabilities, use seccomp RuntimeDefault, omit service account tokens,
and carry `baskule.computer: "true"`. tini is PID 1.

See [Kubernetes installation](../docs/install-kubernetes.md) for RBAC, network policy,
pre-pulling and snapshot restore. Plugin MCP requests originate in celld, so computer
network restrictions do not govern plugin connections.

## Configuration and checks

[Configuration](src/config.ts) is the authoritative environment reference.

| Variable | Default / purpose |
| --- | --- |
| `COMPUTERD_TOKEN` | Required bearer token |
| `COMPUTER_BACKEND` | `docker` or `kubernetes` |
| `COMPUTERD_INSTANCE` | Resource ownership scope; preserve across restores |
| `DOCKER_HOST` | `unix:///var/run/docker.sock` |
| `COMPUTER_NETWORK` | `baskule-computers` |
| `COMPUTER_GUARD_IMAGE` | `baskule-computerd:local` |
| `COMPUTER_DNS` | `1.1.1.1,8.8.8.8` |
| `COMPUTER_IMAGE` | `baskule-computer:local` |
| `COMPUTER_CPUS`, `COMPUTER_MEMORY` | `2`, `3Gi` |
| `COMPUTER_LEGACY_VOLUME` | Legacy Compose disk source; see [migration](../docs/install.md#upgrade-from-050) |
| `IDLE_MINUTES` | `10` |
| `PRODUCT_SETTINGS_URL` | Organization settings endpoint |

Run `scripts/check computerd` from the repository root after [setup](../docs/building.md).
Computers on Docker start in about a second on a warm host; on Kubernetes cold start
is dominated by image pull, which the pre-pull DaemonSet removes.
