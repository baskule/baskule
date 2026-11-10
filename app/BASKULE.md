# Maintain Baskule's T3 Code fork

Baskule uses [T3 Code](https://github.com/pingdotgg/t3code) under its MIT license.
Keep `LICENSE` and third-party notices. [Source provenance](../source-provenance.json)
records the upstream source and licenses. The root [build guide](../docs/building.md)
and [development workflow](../docs/development-workflow.md) cover the complete repository.

Upstream base: T3 Code `v0.1.6` (`2359643cffa6ba9ee84d6f2694b935de54a8013e`).
Update this line with each upstream update.

## Build and run

From the repository root, install the pinned tools and both workspaces' dependencies:

```sh
scripts/worktree setup
source scripts/env.sh
```

Run `scripts/check plan` from the repository root to select checks for your change.

The root workspace and `app/` have separate lockfiles. Run application package commands
from `app/`. For example, build the web client and Node server:

```sh
cd app
pnpm exec vp run --filter @t3tools/web --filter t3 build
```

Before running the local Baskule app or checks that import SpaceCell, run
`scripts/worktree runtime` from the repository root. Rerun it after changing `app/`.
Focused unit checks that do not import SpaceCell need no runtime build.

Use isolated development state. For a standalone Node server, run from an empty working
directory and pass an explicit `--base-dir`. From the repository root:

```sh
mkdir -p .run/t3-dev/cwd .run/t3-dev/home
BASKULE_ROOT="$PWD"
cd .run/t3-dev/cwd
T3CODE_TELEMETRY_ENABLED=false node "$BASKULE_ROOT/app/apps/server/dist/bin.mjs" serve \
  --host 127.0.0.1 --port 47080 --base-dir "$BASKULE_ROOT/.run/t3-dev/home"
```

Keep development databases, credentials and test homes separate from installed application
state. Never start tests or a development server against an installation's data directory.
Do not set `VITE_HTTP_URL` or `VITE_WS_URL` for development: Vite proxies application routes
on the same origin, and fixed origins break remote clients.

Run focused tests from the package that owns them, for example:

```sh
cd app/apps/server
pnpm test src/auth/BaskuleNoAuth.test.ts
```

Use a disposable `HOME` when a test reads user configuration. Web unit tests default to
`VITE_BASKULE_UI=0`; Baskule-specific tests enable their own flags. Native packages require
separate platform verification. See the [Android guide](apps/mobile/BASKULE-ANDROID.md).

## Supported product scope

OpenCode 2 is the only bundled agent driver. Vendor models run through OpenCode.
Local and external OpenCode instances use the provider adapter and instance contracts.
Retired driver settings can decode for compatibility, but have no executable driver.
They are not converted into OpenCode conversations.

Baskule includes chat, files, search, approvals, shared-space authorship, scheduled tasks,
side chats and a shared browser. Hosted chat controls include pinning, snoozing and unread
state. Generic Git operations and local diffs remain in the Node runtime; the SpaceCell
policy disables Git RPCs and server-container terminals. Local-commit review requires Node.

Baskule excludes linked environments and remote delegation, issue triage, port scanning
and developer-server discovery, Simlock pool integration, forge PR workflows, publishing
and review UI, GitHub app sign-in, external secret-provider packages, and T3 commercial
plans and fleet channel switching. The upstream marketing site and its release jobs are
not part of Baskule. Stored metadata, redaction and supported migrations remain compatible
with released data. Generic native connection and pairing contracts remain available.

The mobile client uses Baskule server accounts and space registrations. It has no built-in
T3 cloud sign-in, relay account or mobile telemetry. Operators can configure their own EAS
project and OTA update source. Some mobile screens still use "thread" or "project";
mobile file downloads are not available.

## Authentication and telemetry

Hosted SpaceCells use `BASKULE_AUTH_MODE=front`. The platform authenticates requests,
passes identity to the cell and binds WebSocket tickets to that identity.

`BASKULE_AUTH_MODE=none` is for an operator-controlled access boundary. Anyone who can reach
the server acts as the owner (terminals and access management excluded), even with missing
or unusable credentials. Restrict access with network controls or an authenticating proxy.
Origin checks remain enabled, but do not replace access control. This mode excludes
server-container terminals, source-control writes, preview operation, relay access,
access changes, provider management and environment maintenance. The shared session
survives revocation so a client cannot lock every device out. Browser-session and OAuth
bootstrap endpoints accept arbitrary credentials in this mode. Other auth-mode values
retain their normal authentication behavior.

Telemetry defaults off when `BASKULE=1` or `BASKULE_AUTH_MODE` is set.
`T3CODE_TELEMETRY_ENABLED` overrides that default. Set it to `false` in deployments to
also disable relay tracing, which reads that variable directly.

## Integration points

The platform's `SpaceCell` owns T3 and the embedded OpenCode runtime in one cell.
Keep one shared SQL client, the multiplexed alarm and the same-cell agent request needed
for native I/O ownership on celld. See the [embedded runtime guide](../platform/src/agent/README.md).

The workerd integration lives in `apps/server/src/baskule/workerd/`:

- `spaceServer.ts` assembles the server layers; `doSqlClient.ts` adapts cell SQLite.
- `fileSystem.ts` stores server state in cell SQLite; `computerFs.ts` routes workspace files to computerd.
- `transport.ts` and `routes.ts` handle HTTP and WebSockets with an explicit route policy.
- `shims/` and `trim/` replace Node-only services at bundle time through `build.mjs`.
  Trimmed modules must keep the exports and service keys their callers use.

`apps/server/src/baskule/rpcPolicy.ts` defines hosted commands. It disables settlement,
limits project mutation to pin and archive, and filters MCP tools before registration.
Authorship is stamped at the RPC boundary. `BASKULE_SCRATCH_ROOT` selects chat folders and
`BASKULE_WEBHOOK_BASE` selects the webhook path. Word streaming is enabled in Baskule mode;
`BASKULE_STREAMING=paragraph` selects upstream paragraph streaming.

Web product flags live in `apps/web/src/baskule/flags.ts`. `VITE_BASKULE_UI=0` disables the
Baskule UI switches in the retained client code; it does not restore excluded features.
`VITE_BASKULE_HOSTED=1` enables platform login and one environment per space at `/s/<id>/`.
Baskule UI modules live under `apps/web/src/baskule/`; integration comments identify edits
in upstream files. Keep flags and actual RPC capabilities aligned.

OpenCode compacts automatically. Set each model's real context limit in **Admin > AI > Models**.
There is no manual `/compact` action or idle compaction worker.

## Take a new upstream release

Follow [Upgrade the T3 Code base](../docs/upstream-upgrades.md).
Start from the complete new stable upstream release and selectively reapply the
Baskule behavior still needed from the latest `origin/main`. Adapt retained changes
to upstream's current design and remove custom implementations that upstream replaces.
Disable or remove unwanted product features as explicit changes to the new base.

Keep the release summary short and grouped by product area. Confirm the stable
release and explain the gap first. Report only changes included in the released tag.
The guide covers migration checks, integration boundaries, verification, and PR review.

### Migration boundary

The application migration head is **076**. Peer-only migration IDs 070–072 are absent.
Inspect new upstream migrations for peer tables, fences, indexes and migration-head assumptions.
Do not add empty migrations for excluded layouts. Preserve supported migration code and follow
`packages/contracts/release-compatibility.json` when removing compatibility paths.

Schema and data-layout changes need forward migrations for released installations. Changes that
cannot migrate need maintainer approval and documented deployment steps. Operations on an existing
installation, including deployment, restart or data removal, require its operator's authorization.
