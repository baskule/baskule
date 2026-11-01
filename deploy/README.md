# deploy — the Baskule Docker Compose deployment

Compose project **`baskule`**. It runs a complete installation on one machine; the [installation guide](../docs/install.md) is the short path. See [building from source](../docs/building.md) for prerequisites.

```
 clients ──► 127.0.0.1:47090  baskule-edge (Caddy: round-robin + health checks, X-Forwarded-For)
                                     │  baskule-net
                    ┌────────────────┴────────────────┐
             baskule-celld-a :47091/47092    baskule-celld-b :47091/47092     (stock celld 0.6.3, fleet)
                    └──────────── bucket s3://baskule on baskule-rustfs :47093
             baskule-computerd :47094 ──(baskule-computers)──► baskule-openshell :47095 gRPC, :47096 volumes
                                                                     └─ private dockerd ─ computers os-<spaceId>
 operator ──► 127.0.0.1:47098  baskule-traces (Jaeger UI) ◄── OTLP from celld, the cells, computerd, OpenShell
```

| Service (DNS name) | Container | Image | Notes |
|---|---|---|---|
| `baskule-rustfs` | `baskule-rustfs` | `rustfs/rustfs@sha256:9ca9…` | the fleet bucket; volume `baskule-rustfs` |
| `baskule-bootstrap` | `baskule-bootstrap` | `baskule-celld:local` | one-shot: create the bucket, `celld diagnose` |
| `baskule-celld-a`, `-b` | `baskule-celld-a/-b` | `baskule-celld:local` = `ghcr.io/denoland/celld:0.6.3@sha256:22bc…` + curl, jq, esbuild 0.28.2 | stable `CELLD_NODE`, `CELLD_V8_HEAP_LIMIT_MB=1024`, `CELLD_FETCH_TIMEOUT_S=3600`, `CELLD_MAX_ASSET_FILE_BYTES=512 MiB` (desktop AppImage under `/downloads`), product telemetry off, traces to `baskule-traces` (`CELLD_OTEL`); volumes `baskule-celld-a/-b` |
| `baskule-deploy` | `baskule-deploy` | `baskule-celld:local` | one-shot: `celld deploy` of `platform/` (vars generated from `.env`), or `hello/` |
| `baskule-edge` | `baskule-edge` | `caddy:2@sha256:25cd…` | the **only published port** |
| `baskule-computerd` | `baskule-computerd` | `baskule-computerd:local` (`computerd`) | computer lifecycle; reads the organization idle policy; on both networks |
| `baskule-openshell` | `baskule-openshell` | `baskule-openshell-gateway:local` (`openshell/`) | privileged; volumes `baskule-openshell-docker`, `baskule-openshell-state` |
| `baskule-traces` | `baskule-traces` | `jaegertracing/jaeger:2.22.0@sha256:836b…` | traces of the stack (OTLP 4317/4318 inside, UI published on the configured bind address, port 47098), in memory (20 000 traces, 1 GiB cap; a restart starts empty). Config `traces/jaeger.yaml`; switches in `.env.example` |

For a dedicated host with an external S3-compatible bucket, see [the deployment example](dedicated-host.md).
Automated deployment and CI setup are deferred.

Container names match their `baskule-*` service DNS names.

Product and authentication setup: [installation settings](../docs/installation-settings.md).

## Build from source and deploy: `./build.sh`

One command builds everything the stack runs and deploys it (starting the stack if it is down):

```sh
deploy/build.sh                         # build what changed + deploy (≈1 min incremental, 5-12 min after a fork change on a loaded host)
T3_APP_DIR=$PWD/app deploy/build.sh   # another fork checkout (default: app/)
deploy/build.sh --no-deploy             # build only;  --force: rebuild the web and space bundles anyway
DOWNLOADS=0 deploy/build.sh             # skip the desktop artifacts (~200 MB of assets per deploy)
```

Staging builds run in `build-env/` (Ubuntu 24.04, linux/amd64), matching the host and OpenShell runtime.
Native desktop and mobile packages are release-tag work; main deployments do not build them. See
[the tag release contract](dedicated-host.md#desktop-and-mobile-releases) for the deliberately deferred runner automation.

OpenShell binaries link glibc and a pinned Z3 5.1.0 library (Ubuntu 24.04's packaged Z3 is too old). A build on a newer distribution is not a portable binary for an older
runtime. Additional architectures, Linux baselines, Windows or macOS need their own build/runtime targets and
separate native caches. Do not reuse the Ubuntu 24.04 amd64 outputs as evidence for those targets.

| Step | What | Skipped when |
|---|---|---|
| 1 | hosted web bundle: fork `apps/web`, `VITE_BASKULE_HOSTED=1 vp build` (installs the fork's deps once) | fork content (HEAD + uncommitted diff) unchanged |
| 2 | T3 space-cell bundle: `platform/src/space/sync-bundle.sh` with `T3_APP_DIR` | same |
| 3 | desktop artifacts `desktop/release/*.AppImage`, `*.tar.gz`, `*.apk` (`BASKULE_ARTIFACT_DIR` overrides the directory) staged as `/downloads/` | absent, or `DOWNLOADS=0` |
| 4 | platform bundle: `platform/scripts/build.mjs` (worker + web + downloads) + `dist/web/version.json` | never (≈6 s) |
| 5 | images (`images.sh`): computer, openshell, celld, computerd | an image of the same sources exists on the host (`<name>:src-<hash>`, retagged; the computer is keyed on its browser bundle, not the whole fork) |
| 6 | running stack: recreate services whose image changed, then `deploy.sh`; stopped stack: `up.sh` | `--no-deploy` |
| 7 | `recreate-computers.sh --outdated`: compare each workload's actual image with the desired private-daemon image; recreate only stale computers (volumes kept) | workload already uses the desired image |

It ends by checking that the stack serves the new **`/version.json`**:
`{umbrella, fork, forkBranch, spaceBundle, builtAt, images{computer, computerd, celld, openshell}}`
(`-dirty` = uncommitted changes). Logs of the web and space builds: `.run/build/*-build.log`.

**Stack lock.** Several agents share this stack. Whoever runs tests against it holds `deploy/.stack-lock`
(`owner=… pid=… since=…`; stale after 3 h or when the pid is gone). `build.sh` (deploy step), `deploy.sh` and
`down.sh` refuse to run while another live owner holds it (`STACK_LOCK_IGNORE=1` overrides; `STACK_LOCK_OWNER`
names you). `e2e/run.sh`, `infra-smoke.sh`, `perf/run.sh` and `ux/run.sh` take it for the duration of a run. Which
live loop to run for a change: [development workflow](../docs/development-workflow.md).

**Test LLM selection.** Authorized live runners change the organization AI endpoint and idle policy through
its admin API, saving the prior settings under `.run/`. `e2e/llm/llm.sh restore` restores them without a
redeploy. Component loops seed their own fake connection through that same API.

## Operate

```sh
cd deploy
./init-env.sh                 # .env with random infrastructure secrets
$EDITOR .env                  # infrastructure and first-boot administrator
$EDITOR auth.json             # installation login methods
./up.sh                       # build missing images, start, load the computer image into OpenShell, deploy the app
./up.sh --build               # rebuild every image first (images.sh --all)
./deploy.sh                   # re-deploy after `cd ../platform && pnpm run build` or a vars change
DEPLOY_APP=hello ./deploy.sh  # deploy the tiny validation Worker instead (hello/)
./down.sh                     # stop everything, keep data;  ./down.sh --purge deletes ALL data
../e2e/infra-smoke.sh   # the infrastructure smoke test (≈ 2–4 min; --no-up, --down)
```

Logs: `docker logs -f baskule-celld-a` (structured celld lines), `baskule-computerd` (JSON lines; never the
key), `baskule-openshell` (dockerd + gateway), `baskule-edge` (warnings only),
`docker exec baskule-openshell docker logs <openshell-…-supervisor>` (a computer's egress decisions, OCSF).
State: `docker exec baskule-celld-a curl -s 127.0.0.1:47092/state | jq`, fleet: the smoke test's `celld diagnose`.
Computers: `docker exec baskule-openshell openshell --gateway-endpoint http://127.0.0.1:47095 sandbox list`.

### Vars and secrets

celld has no secrets mechanism (#190): the deploy job writes `PUBLIC_ORIGINS`, `ADMIN_*`, `AUTH_SECRET` (from
`BETTER_AUTH_SECRET`), `COMPUTERD_URL/TOKEN` and the resolved installation `AUTH_CONFIG` into the bucket deployment.
Provider secrets can use `{"env":"NAME"}` references in `auth.json`; the deploy job receives `.env` and resolves
those references without shell evaluation. Never print resolved configuration. `.env` is mode 600 and gitignored;
never source it as shell code.

Organization/AI settings and the write-only AI key live in ControlCell and are changed in **Admin → General → Organization** and **Admin → AI → Models**.
computerd no longer holds or serves AI credentials. After first boot, empty `ADMIN_PASSWORD` in `.env` and redeploy.

### Backup and restore

`./backup.sh [dir]` writes `backups/<UTC date>/` with `baskule-rustfs.tar.gz` (the bucket = every cell: accounts,
spaces, chats), `baskule-openshell-state.tar.gz` (gateway DB, keys) and one `baskule-space-*.tar.gz` per
computer volume (`/sandbox/space`). Run it after `./down.sh` for a consistent copy (live = best effort; celld's RPO=0
log in the bucket is crash-consistent per cell). Copy the directory off the host.
Restore (stack down): recreate each volume and untar into it, e.g.
`docker run --rm --entrypoint sh -v baskule-rustfs:/v -v $PWD/backups/X:/b baskule-celld:local -c 'cd /v && tar xzf /b/baskule-rustfs.tar.gz'`;
space volumes are restored inside the private daemon after `up.sh`:
`docker exec baskule-openshell docker volume create --label openshell.ai/sandbox-attachable=true --label openshell.ai/sandbox-attachable-workspace=default --label baskule.kind=space baskule-space-<s>`
then `docker exec -i baskule-openshell sh -c 'tar -C /var/lib/docker/volumes/baskule-space-<s>/_data -xzf -' < baskule-space-<s>.tar.gz`.

### Update individual components

- **App**: build the platform bundle, then `./deploy.sh`. Nodes adopt the deployment in place. Resident cells move
  when idle or after 60 seconds; sockets close with 1012 and clients reconnect.
- **celld**: change the digest in `celld/Dockerfile` and rebuild with `./images.sh --all`. Roll the nodes one at a time
  with `docker compose up -d --no-deps baskule-celld-a`, wait until healthy, then update `baskule-celld-b`.
  Each stop allows a graceful handoff of up to 40 seconds. Check celld release notes for upgrades that require
  stopping all nodes with `./down.sh` before `./up.sh`.
- **computerd**: `./up.sh --build`. Running execs are cut; computers keep running and are adopted.
- **OpenShell**: see [OpenShell packaging](../openshell/README.md). Recreating `baskule-openshell` stops the computers,
  which restart on next use with their volumes.
- **Computer image**: `../computer/build.sh`, then `./recreate-computers.sh --all`. This loads the image into
  OpenShell and deletes the sandboxes while keeping their volumes. Each computer is recreated on next use.

### Upgrade

Back up the installation with `./down.sh` followed by `./backup.sh`, pull the reviewed release, then run
`./build.sh` to rebuild and deploy it. Keep the backup off the host.

When a release requires a data wipe, back up first, run `./down.sh --purge`, then `./up.sh` with the rebuilt
images and platform bundle. A purge removes the configured bucket (accounts, settings, spaces, chats and
attachments), node caches, gateway state and keys, and every computer's persistent disk. The first boot
recreates the administrator from `.env`; configure the organization and AI again.

### Failover drill

`../e2e/infra-smoke.sh --no-up` ends with it; by hand:
```sh
docker kill baskule-celld-b            # the node owning cells (see /state owned_cells)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47090/   # Worker: still 200 through the edge
# cells owned by the dead node move after its lease (10 s TTL): sign-in worked again after 3–7 s in the drills
docker start baskule-celld-b           # rejoins the fleet; check: docker inspect -f '{{.State.Health.Status}}'
```
Measured: 20/20 Worker requests served during the outage; ControlCell back after 3–7 s.

## Resources (caps)

celld nodes 2 CPU / 3 GiB each, RustFS 1 CPU / 1 GiB, edge 1 CPU / 256 MiB, computerd 1 CPU / 512 MiB,
baskule-openshell 3 CPU / 8 GiB / 16384 pids for **all** computers (each computer: 2 CPU / 3 GiB by default).
Caps are limits, not reservations. Size the host for the combined workload.

## Ports

47090 (edge) and 47098 (traces UI), published on loopback by default; internal: 47091 celld Worker, 47092 celld peers/operator
(unauthenticated: never publish), 47093 RustFS, 47094 computerd, 47095 OpenShell gateway, 47096 volume helper,
47097 gateway health (loopback in its container), 4317/4318 OTLP on `baskule-traces`.

### Native desktop packaging

Run `desktop/build.sh` from the umbrella checkout before publishing downloads. The Linux package is the fork's T3
Electron app with a bundled renderer and native IPC; [desktop/README.md](../desktop/README.md) describes the local
checks and native toolchain. New desktop installs start with a fresh profile and require connecting to the installation.
