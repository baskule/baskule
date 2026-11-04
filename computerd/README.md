# computerd

Stateless HTTP service connecting celld to space computers. [Backend](src/backend.ts)
defines lifecycle, exec and port connections; [DockerBackend](src/docker.ts) serves
Compose and development, and [KubernetesBackend](src/kubernetes.ts) serves Helm installs.
Computer disks mount at `/sandbox/space` and survive stop/start. Deletion removes both
machine and disk. Activity and keep flags are held in memory; idle computers stop.

## Docker

DockerBackend talks to Docker Engine over its Unix socket. Computers run as 1000:1000
on a bridge with inter-container communication disabled (Compose defaults to
`<project>-computers`; standalone computerd defaults to `baskule-computers` when
`COMPUTER_NETWORK` is unset),
CapDrop ALL, no-new-privileges and PidsLimit 1024. Each uses a named
`baskule-space-<suffix>` volume. Exec uses Docker's hijacked stream; port connections
use a relay inside the computer.

[The guard](src/guard.ts) installs a per-network `BASKULE-<hash>` chain derived from
the network ID and subnets. Jumps match the source subnet and bridge interface and
remain in the leading block of DOCKER-USER, FORWARD and INPUT, ahead of other accepts.
It blocks host addresses and private, link-local, CGNAT, loopback, multicast and
reserved IPv4 destinations; IPv6 permits neighbor discovery and blocks local,
unique-local, link-local, loopback and multicast destinations.
Garbage collection removes jumps for vanished bridge interfaces and unreferenced chains.
The guard selects iptables-nft or iptables-legacy (and the IPv6 equivalents) by
the presence of DOCKER-USER. Docker's native nftables backend without that chain
is unsupported. A short-lived helper from the computerd image uses host networking
and NET_ADMIN. Rules reconcile at startup and every 60 seconds. Verification fails
closed: ensure returns HTTP 503 without creating a computer if guard setup fails.
Public DNS defaults avoid blocked private upstreams.

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

## API

All `/v1` routes need `Authorization: Bearer <COMPUTERD_TOKEN>`. `:id` is the space id,
`[A-Za-z0-9_-]{1,64}`. Errors are `{"error": "<message>"}`. Routes other than
`GET .../computer`, `kill`, `stop` and `delete` make the computer ready first.

| Route | Body / query | Answer |
|---|---|---|
| `GET /healthz` (no auth) | | `{ok:true}` |
| `POST /v1/spaces/:id/computer/ensure` | `{"keep"?: boolean}` | status after create/start; `keep` disables idle stop |
| `POST /v1/spaces/:id/computer/stop` | | status after stop; the disk is kept |
| `POST /v1/spaces/:id/computer/delete` | `{"confirm": "<spaceId>"}` | `{sandboxDeleted, volumeDeleted}`; removes machine and disk, irreversible, idempotent |
| `GET /v1/spaces/:id/computer` | | `{phase, running, image, activeStreams, keep, lastActivity, idleStopAt, error, …}`; never starts it |
| `POST /v1/spaces/:id/exec` | see below | NDJSON frames; header `x-exec-id` |
| `POST /v1/spaces/:id/kill` | `{"id", "signal"?, "graceMs"?}` | `{id, killed}`; TERM escalates to KILL after `graceMs` (default 3000) |
| `GET /v1/spaces/:id/files?path=` | `&stat=1`, `Range` | bytes for a file, `{entries:[…]}` for a directory |
| `PUT /v1/spaces/:id/files?path=` | bytes, or `&type=dir` | `{path, type, size}`; atomic write, parents created |
| `GET /v1/spaces/:id/cdp[?target=]` (WebSocket) | | tunnel to the computer's Chromium DevTools (port 9222 inside the computer) |
| `GET /v1/spaces/:id/cdp/json[/list\|/version]` | | DevTools discovery JSON |
| `/v1/spaces/:id/browser/ws` and `browser/{call,events,download,upload,peek}` | | the image's browser bridge on the same shared browser |

**Exec.** The request is JSON `{"argv", "cwd"?, "env"?, "stdin"?: base64, "id"?, "timeoutMs"?}`, or
`application/octet-stream` with that JSON in header `x-baskule-exec` and stdin streamed as the body.
Frames are `{"t":"o"|"e","d":"<base64>"}`, then `{"t":"x","code":N}` or `{"t":"err","msg":"…"}`.
Commands are argv only (no shell built from caller input; argv is capped at 200 KiB). Caller environment
is filtered by an allowlist in [exec.ts](src/exec.ts); `LD_*` is always refused.
Commands do not start a container process each (`runc exec` costs about 100 ms). On first use computerd
opens one backend exec running `/usr/local/bin/node` with a small agent ([agent.mjs](src/agent/agent.mjs),
sent with the command, so images cannot drift from computerd), and multiplexes every later command, stdin,
kill and exit status over it ([session.ts](src/session.ts)). Custom computer images need `/usr/local/bin/node`.
Each command runs in a detached process group and records it in `/tmp/.osj`, so `kill`, client disconnect,
`timeoutMs` and other computerd replicas signal the whole group. Per-command 1 MiB credit windows bound
buffering in both directions; computerd closes a session whose agent exceeds its credit, and waits for slow
HTTP clients before reading more. A failing command (oversized start, bad `cwd`, spawn error) fails alone.
Sessions ping every 15 s, close after 45 s of silence and on stop, replacement, deletion and shutdown;
active commands then fail without retry and the next command opens a new session. While a session is
open and the backend confirmed the computer within 5 s, `ensure` skips the backend query. Sessions do not
count as active request streams. At most `MAX_STREAMS_PER_COMPUTER` exec, file and CDP streams run per computer (429 beyond).

**Files.** Paths are absolute under `/sandbox`; `..` is refused and the path is resolved inside the
computer with `realpath -m` and checked again, so symlinks cannot escape (403).

**Lifecycle.** One computer per space, named by [policy.ts](src/policy.ts) (`os-<suffix>`, disk
`baskule-space-<suffix>`; scoped by `COMPUTERD_INSTANCE` when set). Concurrent ensures share one
operation. Idle computers stop after `IDLE_MINUTES` (or the organization setting) once regenerable
package and browser caches are cleared; on start-up computerd adopts running computers it does not
know, so a restart never leaves them running forever.

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
