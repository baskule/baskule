<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/wordmark-inverse.svg">
    <img alt="Baskule" src="brand/wordmark.svg" width="300">
  </picture>
</p>

<h3 align="center">Self-hosted AI agents for your whole team.</h3>

Baskule is an open-source agent platform that you run on your own servers. Your team chats with agents from the web,
desktop and mobile apps. Each agent has a sandboxed computer, so it can work on files, run code, browse the web and
produce documents instead of only answering. You choose the model.

> [!NOTE]
> Baskule is under active development. Expect breaking changes between releases.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/readme/product-dark.png">
    <img alt="A Baskule agent comparing three supplier quotes from a shared folder and drafting a reply" src="docs/readme/product-light.png" width="900">
  </picture>
</p>

## How it works

Baskule has three parts:

- **Clients.** Web, desktop and mobile apps built on [T3 Code](https://github.com/pingdotgg/t3code). One account,
  the same conversations on every device.
- **Agent platform.** People, groups, personal and team spaces, plugins and usage. It runs an
  [OpenCode](https://github.com/anomalyco/opencode) agent for every conversation. Several platform nodes can run
  side by side, and when one stops another takes over.
- **Computers.** Each space gets an isolated Linux computer with a shell, Python, Node, a browser and office tools,
  sandboxed by [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell). It starts when an agent needs it and stops
  when idle. It can reach the internet, never your private network.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/readme/architecture-dark.png">
    <img alt="The three parts of Baskule: clients, the agent platform and computers, with AI models and company tools connected to the platform" src="docs/readme/architecture-light.png" width="900">
  </picture>
</p>

What Baskule connects to in your environment:

| | |
| --- | --- |
| Model | Mistral, OpenAI, Anthropic, or any OpenAI-compatible endpoint, including your own GPUs. Admins change it in the app. |
| Sign-in | Google, Microsoft, GitHub or any OIDC provider, or passwords. No SAML. |
| Tools | MCP servers and plugins, using the organization's account or each person's own. |
| Storage | All data lives in one S3-compatible bucket, or on the machine's disk. |
| Network | One HTTP port, behind your HTTPS reverse proxy. |
| Monitoring | OpenTelemetry traces, with a bundled Jaeger. |

## What it does

| Area | Today |
| --- | --- |
| Clients | Web app, Linux desktop and Android. macOS and Windows build from source, unsigned. No iOS app yet. |
| Agents | Files, shell, a browser that people can watch, Office and PDF documents, scheduled tasks, voice input. |
| Organization | Personal and team spaces, groups and permissions, invitations. |
| Plugins | Connectors, skills and bundles from public catalogs or your own address, off until an admin enables them for a group. |
| Usage | By person, model and space, with CSV export and per-person limits. |

Not yet: several models in one organization, computers spread across several hosts.

## Install

Run released images on a Linux x86-64 machine with Docker Compose 2.24.4 or newer, 4 CPU cores, 24 GiB RAM and
80 GB free disk. Choose a published version, generate secrets, set the public address and first admin in `.env`,
then start. The [installation guide](docs/install.md) covers configuration, HTTPS, SSO, storage, backups and updates.

```sh
mkdir baskule && cd baskule
VERSION=0.5.0
ASSETS=https://github.com/baskule/baskule/releases/download/v$VERSION
curl -fLO "$ASSETS/docker-compose.yml"
curl -fL "$ASSETS/baskule.env.example" -o .env.example
umask 077
docker run --rm -i --network none --entrypoint baskule-celld-job \
  "${BASKULE_REGISTRY:-ghcr.io/baskule}/baskule-celld:$VERSION" init-env - < .env.example > .env
$EDITOR .env
docker compose up -d
```

For several platform machines with a separate computers host, follow the [cluster guide](docs/install-cluster.md).

## Develop

```sh
scripts/worktree setup         # pinned toolchain and dependencies
source scripts/env.sh
scripts/worktree runtime       # build the chat engine bundle
scripts/stack up --profile light
scripts/stack url
```

The `light` profile runs the platform with a fake model and no computers; `full` adds computers.
[Building from source](docs/building.md) lists the prerequisites, and the
[development workflow](docs/development-workflow.md) explains how to choose checks.

| Directory | Contents |
| --- | --- |
| `app/` | Web, desktop and mobile clients and the chat engine, forked from T3 Code |
| `platform/` | The agent platform: sign-in, organization, spaces, plugins and the OpenCode agent |
| `computer/`, `computerd/` | The computer image and the service that manages computers |
| `openshell/`, `vendor/openshell/` | OpenShell packaging and its patched source |
| `deploy/` | Docker Compose deployment, build container and operation scripts |
| `desktop/` | Desktop packaging |
| `e2e/` | End-to-end tests |
| `scripts/`, `stack/` | Toolchain setup, development stacks and check selection |

## Built on

- [T3 Code](https://github.com/pingdotgg/t3code): the clients and the chat engine started as a fork (MIT).
- [OpenCode](https://github.com/anomalyco/opencode): the agent.
- [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell): the computers' sandbox, included with patches (Apache 2.0).
- [celld](https://github.com/denoland/celld): the runtime of the agent platform.
- [Better Auth](https://github.com/better-auth/better-auth), [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm),
  [RustFS](https://github.com/rustfs/rustfs), [Caddy](https://github.com/caddyserver/caddy),
  [Jaeger](https://github.com/jaegertracing/jaeger), [Playwright MCP](https://github.com/microsoft/playwright-mcp),
  [LibreOffice](https://www.libreoffice.org) and [pandoc](https://pandoc.org).

## Licence

Baskule is released under the [MIT licence](LICENSE). Included third-party code keeps its own licence: `app/` the
T3 Code [MIT licence](app/LICENSE), and `vendor/openshell/` the [Apache 2.0 licence](vendor/openshell/LICENSE) with
its [notices](vendor/openshell/THIRD-PARTY-NOTICES). See [third-party notices](THIRD_PARTY_NOTICES.md) and
[source provenance](source-provenance.json).
