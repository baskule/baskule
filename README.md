# Baskule

Baskule is an experimental agent workspace with personal and shared spaces, conversations, and isolated computers that start when tools need them. It supports configurable model providers and plugins.

This repository contains web, desktop, and mobile client source, platform services, and a patched OpenShell distribution. Baskule is alpha software. Interfaces, storage, and packaging can change without compatibility migrations. Current packaging targets Linux desktop and Android. Other native targets need separate builds and verification.

## Start development

Use Linux x86-64 and follow [Build Baskule](docs/building.md) for prerequisites and toolchain setup. The root and `app/` have separate pnpm workspaces and lockfiles.

```sh
scripts/worktree setup
source scripts/env.sh
```

To prepare the local app, run `scripts/worktree runtime`. This builds the SpaceCell bundle. Rerun it after changing `app/` before starting runtime checks.

Read the [development workflow](docs/development-workflow.md) to choose focused checks, and the [contribution guide](CONTRIBUTING.md) before making changes. Installation configuration is documented in [Installation and organization settings](docs/installation-settings.md).

[Hosted CI and artifact builds](docs/ci.md) describes pull-request checks, release verification, native packages and signing prerequisites.

## Source layout

| Directory | Contents |
| --- | --- |
| `app/` | T3 fork with web, desktop, mobile, and SpaceCell server source |
| `platform/` | Authentication, accounts, spaces, and the embedded OpenCode runtime |
| `computer/v2/`, `computerd/v2/` | Isolated computer image and lifecycle bridge |
| `openshell/`, `vendor/openshell/` | Gateway packaging and patched OpenShell source |
| `desktop/` | Linux packaging and native client checks |
| `deploy/v2/` | Compose deployment and durable storage configuration |
| `e2e/` | Worktree journeys and deployed-stack integration checks |
| `scripts/`, `stack/` | Toolchain setup, development stacks, and check selection |

T3 and OpenCode share one SpaceCell per space. ControlCell owns installation settings and accounts. computerd connects the platform to isolated computers through OpenShell.

## Upstream projects

Baskule includes a fork of [T3 Code](https://github.com/pingdotgg/t3code) and patched [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) source. Their licences and third-party notices remain in their source directories. [Source provenance](source-provenance.json) records the imported snapshots. Later changes belong to this repository's history.

## Licence

Baskule's first-party source is available under the [MIT licence](LICENSE). Vendored code and dependencies retain their own licences. The T3 fork retains its [MIT licence](app/LICENSE), and OpenShell retains its [Apache 2.0 licence](vendor/openshell/LICENSE) and [third-party notices](vendor/openshell/THIRD-PARTY-NOTICES). Nested dependencies include additional notices in their source directories.
