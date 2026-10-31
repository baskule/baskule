# Build Baskule

These instructions target Linux x86-64. The deployment and native build toolchains target Ubuntu 24.04 amd64. Other operating systems and architectures need separate toolchains and verification.

## Install prerequisites

Install Git, Bash, Python 3, curl, tar, xz, checksum tools, and `flock`. Docker with Compose is required for image builds and computer-backed development stacks. The current user must be able to use Docker.

`scripts/worktree` installs checksum-verified Node 26.12.1, the pnpm version pinned in `package.json`, and stock celld 0.6.3. By default, setup uses `baskule` under `XDG_CACHE_HOME` or your home directory's `.cache`. An existing `.tools` link preserves its shared cache location. Set `BASKULE_SHARED` to select another writable directory. Run setup:

```sh
scripts/worktree setup
source scripts/env.sh
```

New linked worktrees inherit the primary checkout's `.tools` location unless `BASKULE_SHARED` selects another root. An existing worktree keeps its own `.tools` location.

Setup links `.tools` and installs dependencies for the root workspace and the separate `app/` workspace. Installations sharing a pnpm store run one at a time because package imports and build hooks modify shared files. Setup replaces generated dependency directories without a terminal prompt and appends plain install output. It does not build SpaceCell. `scripts/worktree host-init` installs only tools and shared caches.

The root workspace contains `platform`, `computerd`, and `e2e`. It has its own lockfile; `app/` keeps a separate workspace and lockfile. After setup, install with `pnpm install --frozen-lockfile` in the appropriate workspace. Use `pnpm --filter <package-name> <script>` from that workspace root.

## Prepare the application runtime

Before launching the local app or checks that import SpaceCell, build the bundle:

```sh
scripts/worktree runtime
```

Rerun this command after changes to `app/`. It skips unchanged inputs. Focused unit checks that do not import the runtime need no bundle build. See [Choose checks for a change](development-workflow.md) for local app startup and verification.

The local celld launcher uses `.tools/bin/celld`, then `celld` on `PATH`. `CELLD_BIN` selects an explicit executable. The setup script extracts stock celld from a pinned official image layer and records its provenance beside the binary.

## Build server, web, and images

Build OpenShell in the Ubuntu 24.04 amd64 environment defined by `deploy/build-env/Dockerfile`. It pins Rust 1.95.0 and Z3 5.1.0. Ubuntu's older system Z3 cannot satisfy this build. The gateway image receives the same shared Z3 library used for linking.

Native compilation requires a matching `CARGO_TARGET_DIR`. Keep native caches separate for each toolchain and target. Follow [OpenShell packaging](../openshell/README.md) for the build environment and [upstream contributor instructions](../vendor/openshell/CONTRIBUTING.md) for source development. Image builds also use jq, rsync, and zstd. Allow disk space for JavaScript dependencies, Rust outputs, and container images.

For a source-build installation, clone the repository and configure its developer Compose override:

```sh
git clone https://github.com/baskule/baskule
cd baskule
deploy/init-env.sh
$EDITOR deploy/.env
```

Set the first admin and public address as in the [installation guide](install.md). `deploy/auth.json` is the
source build's optional authentication file; `AUTH_CONFIG_FILE` selects another. The released installation uses
`AUTH_CONFIG` in `.env` instead. Keep secrets outside Git and do not source `.env` as shell code.

Build and start from the Ubuntu build environment. For example, with the checkout and caches under `/opt/baskule`:

```sh
docker build --network=host -t baskule-build deploy/build-env
docker run --rm --network=host --pid=host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/baskule:/opt/baskule -w /opt/baskule/src baskule-build
```

The build environment installs dependencies and runs `deploy/build.sh`. A cold native build can take 30–60 minutes.
For a linked worktree, also mount its Git common directory and pinned-tool directory at their original paths.
Use this only for an installation you are authorized to operate. To build without starting or replacing services,
override the entry point and set a target-specific native cache:

```sh
build_key=$(sha256sum deploy/build-env/Dockerfile | cut -c1-16)
docker run --rm --network=host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/baskule:/opt/baskule -w /opt/baskule/src \
  -e CARGO_HOME=/opt/baskule/cache/cargo \
  -e CARGO_TARGET_DIR=/opt/baskule/cache/openshell-target-ubuntu24-$build_key \
  baskule-build bash deploy/build.sh --no-deploy
```

`deploy/build.sh` builds the hosted web app, SpaceCell, downloads when available, and platform Worker, then packages
computer, OpenShell, celld, and computerd images. The celld image contains the platform bundle. The gateway contains
compressed computer, supervisor, and sandbox images for its private daemon. Source hashes reuse matching images;
a computer change also rebuilds the gateway, and a platform bundle change rebuilds celld.

The source scripts add `deploy/docker-compose.build.yml` to the single release Compose definition. This selects
`:local` images, build contexts, checkout mounts for rapid app redeployment, and the developer stack's fixed resource
names. `deploy/up.sh` builds missing images and starts this source stack; `deploy/deploy.sh` deploys a changed bundle.
`deploy/down.sh` stops it. `openshell/load-images.sh` remains a developer helper for an existing shared test gateway;
released installations load their images inside Compose. `scripts/stack` and `scripts/check` keep their worktree-local
app path. Do not point them at another operator's installation.

`deploy/build.sh --force` rebuilds web and SpaceCell. `DOWNLOADS=0` omits native downloads. Set
`BASKULE_ARTIFACT_DIR` to a directory of packaged clients to include under `/downloads/`. Image and bundle build
logs stay in `.run/build/`. Deployment scripts honor `deploy/.stack-lock` while checks use the source stack.

Generated bundles, dependencies, downloaded packages, and local evidence stay ignored. Builds use checked-in source and lockfiles. `source-provenance.json` records the imported upstream snapshots; `/version.json` and generated `BUILT_FROM` files identify built inputs.

## Build native clients

Use [the desktop guide](../desktop/README.md) to build the T3-based Electron client with `desktop/build.sh`. It documents native dependencies and packaged-client checks. Desktop builds bundle the renderer and native IPC. Automatic updates are disabled until an update feed is configured.

Mobile source lives in `app/apps/mobile/`. Follow its [README](../app/apps/mobile/README.md) for the Android and iOS toolchains. Source availability does not imply that packages exist or have passed device verification. Keep native signing material outside the checkout's tracked files.
