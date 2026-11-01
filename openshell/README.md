# openshell/ — OpenShell (our fork) packaged for Baskule

Computers run in the patched NVIDIA OpenShell source included at `vendor/openshell`.
The fork is based on v0.1.5 and adds the `public_internet` policy field and 128 network streams per sandbox.
See [building from source](../docs/building.md) for the build environment.

| Path | What |
|---|---|
| `build.sh` | builds the three images below from the compiled binaries in `CARGO_TARGET_DIR/release`; `--cargo` rebuilds them first inside the pinned build environment (niced; staging uses eight jobs) |
| `images/gateway/` | `baskule-openshell-gateway:local`: Ubuntu 24.04 (matching the staging build environment) + static Docker 29 engine + `openshell-gateway` + `openshell` CLI + `volumes.py`; entrypoint runs a private `dockerd` (unix socket only, `--bridge=none --iptables=false`), loads the baked supervisor/sandbox images, generates the supervisor JWT keys on first start, runs the volume helper and the gateway |
| `images/supervisor/` | `baskule-openshell-supervisor:local`: the patched supervisor (+ `ca-certificates`, needed for TLS passthrough) |
| `images/sandbox/` | `baskule-openshell-sandbox:local`: the static `openshell-sandbox` runtime compiled from the fork (Alpine/musl stage, build context = the fork). It enforces the boundary stream limit, which the fork raises (160 streams: 128 network relays + 32 for exec and control) |
| `config/gateway.toml` | gateway config baked into the image (Docker driver on the private daemon, plaintext + unauthenticated on the internal network, telemetry off, `allow_driver_config` with the default resource-admission labels, bind mounts off) |
| `policies/computer.yaml` | the computer policy: `public_internet: true` on 80/443/22 with `tls: skip`, uid 1000. OpenShell has no gateway-wide default policy, so computerd sends this one with every `CreateSandbox` (`computerd/src/policy.ts`, kept in sync by a unit test) |
| `load-images.sh [container] [image…]` | copies images from the host daemon into the private dockerd (only when content differs) |
| `dev-up.sh` / `dev-down.sh [--purge]` | the one private development gateway of the component loops (`osdev-openshell`, gateway 127.0.0.1:47510, volume helper 127.0.0.1:47511), shared by `computerd/test/integration.sh`, `platform/src/agent/test` and `platform/test/wpf` |

## The `baskule-openshell` container (compose service `baskule-openshell`, container `baskule-openshell`)

- **Privileged** (it runs dockerd), CPU/memory/pids caps from compose (`OPENSHELL_CPUS` 3, `OPENSHELL_MEMORY` 8g).
- Ports (internal network `baskule-computers` only): **47095** gateway gRPC, **47096** volume helper (bearer
  `OPENSHELL_VOLUMES_TOKEN`); **47097** gateway health on loopback (container healthcheck).
- Volumes: `/var/lib/docker` (private daemon: images, sandbox containers, **per-space volumes**), `/var/lib/openshell`
  (gateway SQLite DB, JWT keys).
- Sandboxes run `--network none`; their supervisors are host-networked **in this container's network namespace**, so
  computers never share a network with celld, RustFS or the edge. The fork admits only globally routable public
  unicast destinations not owned by the supervisor's own netns (`e2e/infra-smoke.sh` probes 60 private
  destinations from inside a computer: all refused).
- Resource names inside the private daemon are OpenShell's own (`openshell-*` containers); the host daemon only sees
  `baskule-openshell`.

### Volume helper (`volumes.py`)

The Docker driver only mounts **existing** named volumes carrying the admission labels
(`openshell.ai/sandbox-attachable=true`, `openshell.ai/sandbox-attachable-workspace=default`), and computerd has no
Docker access. `PUT/GET/DELETE /volumes/baskule-space-<suffix>` (bearer token) is the single capability computerd
gets on the private dockerd. Docker copies the image's `/sandbox/space` content (an empty `home/`) into a new volume
on first mount.

## Notes / gotchas found while packaging

- The gateway refuses to start unless the **supervisor image is already present** in its daemon: build.sh bakes the
  supervisor and sandbox images into the gateway image as tarballs; the entrypoint loads them when they differ.
- `/healthz` is **not** on the gRPC port (404 there); it is on `health_bind_address` (47097, loopback).
- Image IDs differ between the host's and the private daemon's (containerd) image store; `load-images.sh` compares
  creation time + layer digests instead.
- Docker 29's static engine embeds containerd (no `containerd` binary in `docker:29-dind`).
- If the default Docker CLI configuration is not writable, build scripts use `DOCKER_CONFIG=~/.local/baskule/docker-cli`.
  Builds use `--network host`.

## Upgrading the fork

Update `vendor/openshell` from NVIDIA/OpenShell and retain the local policy and stream-capacity patches.
Rebuild with `./build.sh --cargo` and refresh the vendored protos with
`computerd/scripts/vendor-protos.sh`. Choose the focused checks from the
[development workflow](../docs/development-workflow.md) before deploying.
Recreating `baskule-openshell` stops its computers; they restart with their volumes on next use.

## Native build target

Compile the gateway, supervisor and CLI inside `deploy/build-env` (Ubuntu 24.04 amd64), matching their runtime
images. The environment installs the checksum-pinned official Z3 5.1.0 glibc-2.39 release; Noble's system Z3 4.8
is older than z3-sys 0.13's minimum 4.13.3. The gateway image receives the same `libz3.so` used to link it.
`CARGO_TARGET_DIR` selects the matching native cache; staging uses `/opt/baskule/cache/openshell-target-ubuntu24-<toolchain hash>`.
The build-environment Dockerfile participates in the OpenShell image key. Additional targets need matching
compiler, glibc/Z3 runtime and separate native caches; outputs from a newer host cannot be reused on older Linux.
