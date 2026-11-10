# Build Baskule

Development requires Linux x86-64; `scripts/worktree` enforces this requirement. Contributors on macOS or Windows need a Linux x86-64 VM. The deployment and native build toolchains target Ubuntu 24.04 amd64.

## Install prerequisites

Install Git, Bash, Python 3, curl, tar, xz, checksum tools, and `flock`. Docker with Compose is required for image builds and computer-backed development stacks. The current user must be able to use Docker. The optional local HTTPS proxy requires root, a globally installed `portless`, and `libnss3-tools` for browser certificate trust. Without root or Portless, `scripts/stack up` automatically uses direct loopback HTTP. Set `BASKULE_STACK_PROXY=0` or `1` to disable or require the proxy explicitly.

`scripts/worktree` installs checksum-verified Node 26.12.1, the pnpm version pinned in `package.json`, and celld 0.6.3. By default, setup uses `baskule` under `XDG_CACHE_HOME` or your home directory's `.cache`. An existing `.tools` link preserves its shared cache location. Set `BASKULE_SHARED` to select another writable directory. Run setup:

```sh
scripts/worktree setup
source scripts/env.sh
```

New linked worktrees inherit the primary checkout's `.tools` location unless `BASKULE_SHARED` selects another root.

Setup links `.tools` and installs dependencies for the root workspace and the separate `app/` workspace. Installations sharing a pnpm store run one at a time because package imports and build hooks modify shared files. Setup replaces generated dependency directories without a terminal prompt and appends plain install output. It does not build SpaceCell. `scripts/worktree host-init` installs only tools and shared caches.

The root workspace contains `platform`, `computerd`, and `e2e`. It has its own lockfile; `app/` keeps a separate workspace and lockfile. After setup, install with `pnpm install --frozen-lockfile` in the appropriate workspace. Use `pnpm --filter <package-name> <script>` from that workspace root.

## Prepare the application runtime

Before launching the local app or checks that import SpaceCell, build the bundle:

```sh
scripts/worktree runtime
```

Rerun this command after changes to `app/`. It skips unchanged inputs. Focused unit checks that do not import the runtime need no bundle build. See [Choose checks for a change](development-workflow.md) for local app startup and verification.

The local celld launcher uses `.tools/bin/celld`, then `celld` on `PATH`. `CELLD_BIN` selects an explicit executable. The setup script extracts celld 0.6.3 from a pinned official image layer and records its provenance beside the binary.

## Build server, web, and images

Before `scripts/stack up --profile full` or `scripts/check agent`, `computerd`, or `features`, build the hosted web app, SpaceCell, platform bundle, and computer, celld, and computerd images:

```sh
deploy/build.sh --no-deploy
```

Docker, jq and the pinned JavaScript tools are required. Build logs stay in `.run/build/`.
`deploy/build.sh --force --no-deploy` rebuilds the web and SpaceCell bundles.
For an installation you operate, `deploy/build.sh` also starts and deploys the source stack.
`deploy/docker-compose.build.yml` selects local images and checkout mounts.
`deploy/up.sh` starts it, `deploy/deploy.sh` deploys a changed bundle, and `deploy/down.sh` stops it.
The optional `deploy/.env` overrides defaults; `AUTH_CONFIG_FILE` selects an authentication file.
Keep secrets outside Git and do not source `.env` as shell code.

Generated bundles, dependencies, downloaded packages, and local evidence stay ignored. Builds use checked-in source and lockfiles. `source-provenance.json` records upstream sources and their licenses; `/version.json` and generated `BUILT_FROM` files identify built inputs.

## Build native clients

Use [the desktop guide](../desktop/README.md) to build the T3-based Electron client with `desktop/build.sh`. It documents native dependencies and packaged-client checks. Desktop builds bundle the renderer and native IPC. Automatic updates select the latest release compatible with the selected installation; see the desktop guide.

Mobile source lives in `app/apps/mobile/`. Follow its [README](../app/apps/mobile/README.md) for the Android and iOS toolchains. Source availability does not imply that packages exist or have passed device verification. Keep native signing material outside the checkout's tracked files.

Use [native mobile verification](mobile-verification.md) to exercise the app on a device with
a disposable fake-model backend, including a remote emulator host when the build host lacks KVM.
