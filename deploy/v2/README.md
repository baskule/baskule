# deploy/v2 — the Baskule Docker Compose deployment

Compose project **`baskule02`**. It runs a complete installation on one machine; the [installation guide](../../docs/install.md) is the short path. The 0.1 deployment is retired; its source remains in `deploy/`. See [building from source](../../docs/building.md) for prerequisites.

```
 clients ──► 127.0.0.1:47090  baskule-edge (Caddy: round-robin + health checks, X-Forwarded-For)
                                     │  baskule02-net
                    ┌────────────────┴────────────────┐
             baskule-celld-a :47091/47092    baskule-celld-b :47091/47092     (stock celld 0.6.3, fleet)
                    └──────────── bucket s3://baskule02 on baskule-rustfs :47093
             baskule-computerd :47094 ──(baskule02-computers)──► baskule-openshell :47095 gRPC, :47096 volumes
                                                                     └─ private dockerd ─ computers os-<spaceId>
 operator ──► 127.0.0.1:47098  baskule-traces (Jaeger UI) ◄── OTLP from celld, the cells, computerd, OpenShell
```

| Service (DNS name) | Container | Image | Notes |
|---|---|---|---|
| `baskule-rustfs` | `baskule02-rustfs` | `rustfs/rustfs@sha256:9ca9…` | the fleet bucket; volume `baskule02-rustfs` |
| `baskule-bootstrap` | `baskule02-bootstrap` | `baskule-celld:0.2` | one-shot: create the bucket, `celld diagnose` |
| `baskule-celld-a`, `-b` | `baskule02-celld-a/-b` | `baskule-celld:0.2` = `ghcr.io/denoland/celld:0.6.3@sha256:22bc…` + curl, jq, esbuild 0.28.2 | stable `CELLD_NODE`, `CELLD_V8_HEAP_LIMIT_MB=1024`, `CELLD_FETCH_TIMEOUT_S=3600`, `CELLD_MAX_ASSET_FILE_BYTES=512 MiB` (desktop AppImage under `/downloads`), product telemetry off, traces to `baskule-traces` (`CELLD_OTEL`); volumes `baskule02-celld-a/-b` |
| `baskule-deploy` | `baskule02-deploy` | `baskule-celld:0.2` | one-shot: `celld deploy` of `platform/` (vars generated from `.env`), or `hello/` |
| `baskule-edge` | `baskule02-edge` | `caddy:2@sha256:25cd…` | the **only published port** |
| `baskule-computerd` | `baskule02-computerd` | `baskule-computerd:0.2` (`computerd/v2`) | computer lifecycle; reads the organization idle policy; on both networks |
| `baskule-openshell` | `baskule02-openshell` | `baskule-openshell-gateway:0.2` (`openshell/`) | privileged; volumes `baskule02-openshell-docker`, `baskule02-openshell-state` |
| `baskule-traces` | `baskule02-traces` | `jaegertracing/jaeger:2.22.0@sha256:836b…` | traces of the stack (OTLP 4317/4318 inside, UI published on the configured bind address, port 47098), in memory (20 000 traces, 1 GiB cap; a restart starts empty). Config `traces/jaeger.yaml`; switches in `.env.example` |

For a dedicated host with an external S3-compatible bucket, see [the deployment example](contabo.md).
Automated deployment and CI setup are deferred.

Containers retain the `baskule02-*` names originally chosen to coexist with 0.1; service names are the
`baskule-*` DNS names from the architecture.

Product and authentication setup: [installation settings](../../docs/installation-settings.md).

## Build from source and deploy: `./build.sh`

One command builds everything the 0.2 stack runs and deploys it (starting the stack if it is down):

```sh
deploy/v2/build.sh                         # build what changed + deploy (≈1 min incremental, 5-12 min after a fork change on a loaded host)
T3_APP_DIR=$PWD/app deploy/v2/build.sh   # another fork checkout (default: app/)
deploy/v2/build.sh --no-deploy             # build only;  --force: rebuild the web and space bundles anyway
DOWNLOADS=0 deploy/v2/build.sh             # skip the desktop artifacts (~200 MB of assets per deploy)
```

Staging builds run in `build-env/` (Ubuntu 24.04, linux/amd64), matching the host and OpenShell runtime.
Native desktop and mobile packages are release-tag work; main deployments do not build them. See
[the tag release contract](contabo.md#desktop-and-mobile-releases) for the deliberately deferred runner automation.

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

**Stack lock.** Several agents share this stack. Whoever runs tests against it holds `deploy/v2/.stack-lock`
(`owner=… pid=… since=…`; stale after 3 h or when the pid is gone). `build.sh` (deploy step), `deploy.sh` and
`down.sh` refuse to run while another live owner holds it (`STACK_LOCK_IGNORE=1` overrides; `STACK_LOCK_OWNER`
names you). `e2e/v2/run.sh`, `infra-smoke.sh`, `perf/run.sh` and `ux/run.sh` take it for the duration of a run. Which
live loop to run for a change: [development workflow](../../docs/development-workflow.md).

**Test LLM selection.** Authorized live runners change the organization AI endpoint and idle policy through
its admin API, saving the prior settings under `.run/`. `e2e/v2/llm/llm.sh restore` restores them without a
redeploy. Component loops seed their own fake connection through that same API.

## Operate

```sh
cd deploy/v2
./init-env.sh                 # .env with random infrastructure secrets
$EDITOR .env                  # infrastructure and first-boot administrator
$EDITOR auth.json             # installation login methods
./up.sh                       # build missing images, start, load the computer image into OpenShell, deploy the app
./up.sh --build               # rebuild every image first (images.sh --all)
./deploy.sh                   # re-deploy after `cd ../../platform && pnpm run build` or a vars change
DEPLOY_APP=hello ./deploy.sh  # deploy the tiny validation Worker instead (hello/)
./down.sh                     # stop everything, keep data;  ./down.sh --purge deletes ALL 0.2 data
../../e2e/v2/infra-smoke.sh   # the infrastructure smoke test (≈ 2–4 min; --no-up, --down)
```

Logs: `docker logs -f baskule02-celld-a` (structured celld lines), `baskule02-computerd` (JSON lines; never the
key), `baskule02-openshell` (dockerd + gateway), `baskule02-edge` (warnings only),
`docker exec baskule02-openshell docker logs <openshell-…-supervisor>` (a computer's egress decisions, OCSF).
State: `docker exec baskule02-celld-a curl -s 127.0.0.1:47092/state | jq`, fleet: the smoke test's `celld diagnose`.
Computers: `docker exec baskule02-openshell openshell --gateway-endpoint http://127.0.0.1:47095 sandbox list`.

### Vars and secrets

celld has no secrets mechanism (#190): the deploy job writes `PUBLIC_ORIGINS`, `ADMIN_*`, `AUTH_SECRET` (from
`BETTER_AUTH_SECRET`), `COMPUTERD_URL/TOKEN` and the resolved installation `AUTH_CONFIG` into the bucket deployment.
Provider secrets can use `{"env":"NAME"}` references in `auth.json`; the deploy job receives `.env` and resolves
those references without shell evaluation. Never print resolved configuration. `.env` is mode 600 and gitignored;
never source it as shell code.

Organization/AI settings and the write-only AI key live in ControlCell and are changed in **Admin → General → Organization** and **Admin → AI → Models**.
computerd no longer holds or serves AI credentials. After first boot, empty `ADMIN_PASSWORD` in `.env` and redeploy.

### Backup and restore

`./backup.sh [dir]` writes `backups/<UTC date>/` with `baskule02-rustfs.tar.gz` (the bucket = every cell: accounts,
spaces, chats), `baskule02-openshell-state.tar.gz` (gateway DB, keys) and one `baskule-space-*.tar.gz` per
computer volume (`/sandbox/space`). Run it after `./down.sh` for a consistent copy (live = best effort; celld's RPO=0
log in the bucket is crash-consistent per cell). Copy the directory off the host.
Restore (stack down): recreate each volume and untar into it, e.g.
`docker run --rm --entrypoint sh -v baskule02-rustfs:/v -v $PWD/backups/X:/b baskule-celld:0.2 -c 'cd /v && tar xzf /b/baskule02-rustfs.tar.gz'`;
space volumes are restored inside the private daemon after `up.sh`:
`docker exec baskule02-openshell docker volume create --label openshell.ai/sandbox-attachable=true --label openshell.ai/sandbox-attachable-workspace=default --label baskule.kind=space baskule-space-<s>`
then `docker exec -i baskule02-openshell sh -c 'tar -C /var/lib/docker/volumes/baskule-space-<s>/_data -xzf -' < baskule-space-<s>.tar.gz`.

### Upgrade

The Baskule identity change requires a fresh installation. API paths, session cookies, environment variables,
container and volume names, computer labels, and browser profiles now use the Baskule name.
Before deploying over an earlier installation, back up its data and explicitly retire its old stack and data.
The renamed scripts address `baskule02` resources and cannot purge volumes created under a different project name.
Create a new `.env` from the example and reinstall any runner services with their new names and staging settings.
There is no compatibility import. Renaming the source alone does not alter a running deployment or its volumes.

**2026-10-26 voice input:** `transcription` is required in product settings, so a stored settings row from
before this change no longer parses and every `/me` call fails. Deploy it with the same wipe as the 0.3 change
below: back up if wanted, run `./down.sh --purge`, rebuild and run `./up.sh`, then configure the organization,
AI and AI → Voice input in the admin area. celld has no command to run SQL inside a cell, so there is no
narrower wipe. No compatibility import is performed.

**0.3 settings/authentication change:** the product configuration layout changed. Back up if wanted, run
`./down.sh --purge`, configure `.env` and `auth.json`, rebuild and run `./up.sh`, then configure the organization
and AI in the admin area. AI configuration now stores one provider and one model, using native provider/model
IDs; provider keys are scoped to their endpoint. Mistral Large 4 is the initial selection: enter a Mistral key
with access to `mistral-large-4` after the wipe. Old `ORG_NAME`, `BASKULE_LLM_*` and `IDLE_MINUTES` deployment values are retired.
Switching authenticated ↔ anonymous mode also requires a wipe. No compatibility import is performed.


- **App** (platform): build it, `./deploy.sh`. Nodes adopt the new deployment in place (resident cells move when
  idle, forced after 60 s: sockets close with 1012, clients reconnect). Baskule has no data migrations: when a
  change says it needs a data wipe, back up if wanted, `./down.sh --purge`, `./up.sh`, then deploy; the first boot
  recreates the admin from `.env` (`ADMIN_*`).
- **celld**: change the digest in `celld/Dockerfile` and rebuild (`./images.sh --all`), then roll the nodes one
  at a time: `docker compose up -d --no-deps baskule-celld-a`, wait until healthy, then `baskule-celld-b` (each
  stop is a graceful handoff of up to 40 s). Check the celld release notes for "stop-all" upgrades first: those need
  `./down.sh && ./up.sh`.
- **computerd**: `./up.sh --build` (stateless; running execs are cut, computers keep running and are adopted).
- **OpenShell fork**: see `openshell/README.md`; recreating `baskule-openshell` stops the computers, which restart
  on next use with their volumes.
- **Computer image**: `../../computer/v2/build.sh`, then `./recreate-computers.sh --all` (loads the image into
  OpenShell, deletes the sandboxes; volumes are kept; each computer is recreated on next use).

### Failover drill

`../../e2e/v2/infra-smoke.sh --no-up` ends with it; by hand:
```sh
docker kill baskule02-celld-b            # the node owning cells (see /state owned_cells)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47090/   # Worker: still 200 through the edge
# cells owned by the dead node move after its lease (10 s TTL): sign-in worked again after 3–7 s in the drills
docker start baskule02-celld-b           # rejoins the fleet; check: docker inspect -f '{{.State.Health.Status}}'
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
Electron app with a bundled renderer and native IPC; [desktop/README.md](../../desktop/README.md) describes the local
checks and native toolchain. The former standalone Electron shell has been removed. New desktop installs start
with a fresh profile and require reconnecting; this change needs no server-data wipe.

## T3 Code v0.1.3 toolchain

Build this revision with Node 26.12.1 and pnpm 12.14.0. Rebuild the build-environment image from
`deploy/v2/build-env/Dockerfile`; it installs pnpm directly with npm because Node 26 does not
include Corepack. On a source-build host, run `scripts/worktree setup`, source `scripts/env.sh`,
and rebuild SpaceCell with `scripts/worktree runtime` before building the app. Both workspaces
require their checked-in frozen lockfiles.

Deploy the web client and embedded server bundle together through the installation's normal
reviewed deployment procedure. This upgrade adds no Baskule data-wipe requirement for an
already OpenCode-only installation. Existing wipe requirements above still apply.
Native clients need fresh platform builds; a hosted deployment does not replace installed clients.
