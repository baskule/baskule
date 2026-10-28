# Build Baskule

These instructions target Linux x86-64. The deployment and native build toolchains target Ubuntu 24.04 amd64. Other operating systems and architectures need separate toolchains and verification.

## Install prerequisites

Install Git, Bash, Python 3, curl, tar, xz, checksum tools, and `flock`. Docker with Compose is required for image builds and computer-backed development stacks. The current user must be able to use Docker.

`scripts/worktree` installs checksum-verified Node 24.22.1, the pnpm version pinned in `package.json`, and stock celld 0.6.3. By default, setup uses `baskule` under `XDG_CACHE_HOME` or your home directory's `.cache`. An existing `.tools` link preserves its shared cache location. Set `BASKULE_SHARED` to select another writable directory. Run setup:

```sh
scripts/worktree setup
source scripts/env.sh
```

New linked worktrees inherit the primary checkout's `.tools` location unless `BASKULE_SHARED` selects another root. An existing worktree keeps its own `.tools` location.

Setup links `.tools` and installs dependencies for the root workspace and the separate `app/` workspace. Installations sharing a pnpm store run one at a time because package imports and build hooks modify shared files. Setup replaces generated dependency directories without a terminal prompt and appends plain install output. It does not build SpaceCell. `scripts/worktree host-init` installs only tools and shared caches.

The root workspace contains `platform`, `computerd/v2`, and `e2e`. It has its own lockfile; `app/` keeps a separate workspace and lockfile. After setup, install with `pnpm install --frozen-lockfile` in the appropriate workspace. Use `pnpm --filter <package-name> <script>` from that workspace root.

## Prepare the application runtime

Before launching the local app or checks that import SpaceCell, build the bundle:

```sh
scripts/worktree runtime
```

Rerun this command after changes to `app/`. It skips unchanged inputs. Focused unit checks that do not import the runtime need no bundle build. See [Choose checks for a change](development-workflow.md) for local app startup and verification.

The local celld launcher uses `.tools/bin/celld`, then `celld` on `PATH`. `CELLD_BIN` selects an explicit executable. The setup script extracts stock celld from a pinned official image layer and records its provenance beside the binary.

## Build server, web, and images

Build OpenShell in the Ubuntu 24.04 amd64 environment defined by `deploy/v2/build-env/Dockerfile`. It pins Rust 1.95.0 and Z3 5.1.0. Ubuntu's older system Z3 cannot satisfy this build. The gateway image receives the same shared Z3 library used for linking.

Native compilation requires a matching `CARGO_TARGET_DIR`. Keep native caches separate for each toolchain and target. Follow [OpenShell packaging](../openshell/README.md) for the build environment and [upstream contributor instructions](../vendor/openshell/CONTRIBUTING.md) for source development. Image builds also use jq, rsync, and zstd. Allow disk space for JavaScript dependencies, Rust outputs, and container images.

Create private runtime configuration as described in [the deployment guide](../deploy/v2/README.md). From a prepared build environment, build without replacing a running installation:

```sh
deploy/v2/build.sh --no-deploy
```

Omitting `--no-deploy` also deploys. The build environment's `run.sh` entry point also builds and deploys; it is not a build-only command. Use deployment commands only for an installation you are authorized to operate. Keep `.env`, authentication secrets, storage credentials, and signing keys outside Git.

Generated bundles, dependencies, downloaded packages, and local evidence stay ignored. Builds use checked-in source and lockfiles. `source-provenance.json` records the imported upstream snapshots; `/version.json` and generated `BUILT_FROM` files identify built inputs.

## Build native clients

Use [the desktop guide](../desktop/README.md) to build the T3-based Electron client with `desktop/build.sh`. It documents native dependencies and packaged-client checks. Desktop builds bundle the renderer and native IPC. Automatic updates are disabled until an update feed is configured.

Mobile source lives in `app/apps/mobile/`. Follow its [README](../app/apps/mobile/README.md) for the Android and iOS toolchains. Source availability does not imply that packages exist or have passed device verification. Keep native signing material outside the checkout's tracked files.
