# Maintain Baskule's T3 Code fork

Baskule uses [T3 Code](https://github.com/pingdotgg/t3code) under its MIT license.
Keep `LICENSE` and third-party notices. [Source provenance](../source-provenance.json)
records the upstream source and licenses. The root [build guide](../docs/building.md)
and [development workflow](../docs/development-workflow.md) cover the complete repository.

Upstream base: T3 Code `v0.1.12` (`ca81b7b97a1c4b91e5ac25768d0f6629f37732fd`).
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

`app/pnpm-workspace.yaml` enables pnpm's global virtual store so worktrees share resolved
dependency graphs. Its `supportedArchitectures` includes Linux x64 glibc dependencies for
the AppImage build. The four mobile module entries resolve the app's `workspace:*` native
dependencies for Expo autolinking and packaging.

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

OpenCode 2 is the only bundled agent driver. The app client/protocol/schema and embedded
core/schema/SDK/util use exactly 2.2.5. The unused OpenCode 1 SDK is removed.
Vendor models run through OpenCode.
Local and external OpenCode instances use the provider adapter and instance contracts.
Retired driver settings can decode for compatibility, but have no executable driver.
They are not converted into OpenCode conversations.

Baskule includes chat, files, search, approvals, shared-space authorship, scheduled tasks,
side chats and a shared browser. Hosted chat controls include pinning, snoozing and unread
state. Generic Git operations and local diffs remain in the Node runtime; the SpaceCell
policy disables Git RPCs and server-container terminals. Local-commit review requires Node.

The per-space computer browser loads operator-provided unpacked extensions from
`BASKULE_BROWSER_EXTENSIONS`. Its native viewers attach with the active space connection
and revoke streams and acquired files when the account or space changes.

Baskule excludes linked environments and remote delegation, issue triage, port scanning,
developer-server discovery, the remote browser tunnel, port forwarding, Simlock pool integration, forge PR workflows, publishing
and review UI, GitHub app sign-in, external secret-provider packages, beta workflows, external
MCP event feeds, agent feedback, and T3 commercial plans and fleet channel switching. Baskule
verifies its hosted stack with the root fake-model journeys. Baskule ships its own
site and release jobs. Stored metadata, redaction and supported migrations remain compatible
with released data. Generic native connection and pairing contracts remain available.
Peer-link issuance and MCP link-origin fences apply only to upstream linked environments.
The Baskule 0.5.4 compatibility window needs neither peer-link pairing fields nor the
preview tunnel setting.

The mobile client uses Baskule server accounts and space registrations. It supports authenticated
attachment and browser downloads through the native share sheet. Operators can configure their own
EAS project and OTA update source. Baskule builds disable T3 cloud sign-in, relay accounts and mobile
telemetry.

Tool calls default to hidden through the shared client visibility setting. Explicit saved
choices are preserved, including settings saved by 0.5.3. The working shelf defaults off
so a chat stays in place when the user sends a message. Upstream screen-reader announcement levels
remain available. Web, desktop, and mobile use General Translation with the released locales plus Dutch and Italian.

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

Telemetry defaults off in CI and when `BASKULE=1` or `BASKULE_AUTH_MODE` is set.
`T3CODE_TELEMETRY_ENABLED` overrides that default. Set it to `false` in deployments to
also disable relay tracing, which reads that variable directly.

## Integration points

The platform's `SpaceCell` owns T3 and the embedded OpenCode runtime in one cell.
Keep one shared SQL client, the multiplexed alarm and the same-cell agent request needed
for native I/O ownership on celld. See the [embedded runtime guide](../platform/src/agent/README.md).

The workerd integration lives in `apps/server/src/baskule/workerd/`:

- `spaceServer.ts` assembles the server layers; `doSqlClient.ts` adapts cell SQLite.
- `fileSystem.ts` stores server state in cell SQLite. `computerFs.ts` routes workspace files to computerd.
  The Space filesystem preserves its errno in the Effect error cause. It returns `EISDIR` for
  directory handles, so `atomicWrite.ts` treats that error as unsupported directory sync after
  the rename has already persisted.
- `transport.ts` and `routes.ts` handle HTTP and WebSockets with an explicit route policy.
- `shims/` and `trim/` replace Node-only services at bundle time through `build.mjs`.
  The terminal adapter preserves upstream's service and layer signatures while refusing
  local terminal operations. The btrfs attribute helper is inert because SpaceCell SQL owns
  its storage; app directories do not contain a host SQLite database to mark No_COW.
  Hosted composition omits Node provider-process ownership and systemd scopes because the
  embedded agent runs in the cell and executable tools run on its computer.
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

The browser wait adapter retains the released Baskule `loadState` condition by checking
`document.readyState` inside upstream’s bounded wait.

Voice input uses upstream's shared recording session, dictation controls, and browser PCM capture. Upstream's local-model, cloud-provider and destination code stays in the web tree so
later upgrades merge cleanly; `BASKULE_HOSTED` gates it off, and no Baskule build can grant it a
destination. Hosted builds send each finished
recording to the platform's `/api/baskule/transcriptions` route while the account has voice input,
and record from the browser's default microphone because no Baskule web build can choose one. They
show no voice settings route, search result, setup dialog or settings action. Mobile deletes
upstream's `t3-voice-transcription` native module and uses the same route; **Settings → Voice**
remains for microphone access and the preferred-microphone order its recorder applies.
Saved speech settings still decode. The Apple Speech helper and native IPC are omitted.

General Translation resolves client copy from checked-in catalogs. The browser and desktop
renderer migrate the released language cookie or local storage value into client settings.
Mobile adopts the old AsyncStorage preference into its preferences database. Automatic selection
follows the device language order. Native permission descriptions come from the mobile catalog
at build time. See the [localization guide](../docs/localization.md).

Missing tool-visibility preferences default to `hideAll` through the upstream preference model.
Every explicit saved choice is preserved. Dictation uses upstream's current snapshot and insertion
model, including submitting a finished recording to its original draft after navigation.

The embedded build adapts OpenCode 2.2.5’s Code Mode queue so completed host tools are not starved
by polling jobs. Native goal controls refresh their state before settling because a command can
finish before its goal notification is ingested. Hosted MCP reads retain upstream’s bounded caller
reads; task ownership separately loads the human-input records needed for authorization.
Model-facing sender notes name Baskule in prompts from agents, MCP clients, and scheduled tasks.

The OpenCode adapter can reconnect its event subscription as soon as the disposed runtime closes
the stream. The SpaceCell disposal test checks that every stream open before disposal is closed
by comparing stream IDs. A replacement subscription can appear on the new runtime.
Hosted OpenCode uses the installation's catalog in every location. Catalog refreshes keep their
one-shot reads and wait for a workspace scan when requested. The hosted driver skips upstream's
persistent background catalog and location-scan subscriptions.

OpenCode compacts automatically. Set each model's real context limit in **Admin > AI > Models**.
There is no manual `/compact` action or idle compaction worker.

## Take a new upstream release

Follow [Upgrade the T3 Code base](../docs/upstream-upgrades.md).
The current [integration review](../docs/upstream-v0.1.12-integration.md) records the release
decisions and verification boundary.
Start from the complete new stable upstream release and selectively reapply the
Baskule behavior still needed from the latest `origin/main`. Adapt retained changes
to upstream's current design and remove custom implementations that upstream replaces.
Disable or remove unwanted product features as explicit changes to the new base.

Keep the release summary short and grouped by product area. Confirm the stable
release and explain the gap first. Report only changes included in the released tag.
The guide covers migration checks, integration boundaries, verification, and PR review.

### Bundle-time customizations

Revalidate these customizations when T3, Effect or embedded OpenCode changes:

- `hostedComposition.mjs` rewrites upstream `server.ts` at complete Layer expressions for
  ProviderRegistry, keybindings/theme, command readiness, speech storage, native telemetry,
  host power, managed endpoints, and analytics. The speech store also exposes `link` and
  `linkedFrom`; hosted mutations refuse local files and queries report absence. `hostedTrims.ts`
  retains the hosted service keys;
  `hostedLayers.ts` keeps per-Space acquisition and readiness policy.
- The same plugin rewrites `environment/ServerEnvironment.ts` at machine-kind detection and
  `environment/ServerEnvironmentLabel.ts` at the friendly-host probe. Upstream label normalization
  and its hostname/cwd fallback remain. Cells use their adapter hostname without host probes.
- It rewrites `auth/McpOAuth.ts` at signer construction and both sign/verify calls.
  `deferredService.ts` captures Space dependencies, caches successes only, and owns first-use resources.
  ProviderRegistry, EnvironmentTheme, and OAuth signing use it; lifetime services remain eager.
- It drops the synchronous process-exit log flush and its Node filesystem import from
  `packages/shared/src/observability.ts`. Spaces use the injected filesystem for asynchronous flush and close.
- `sharedHttpCodecs.mjs` rewrites Effect 4.1.5's `dist/http-api/HttpApiBuilder.js` at
  `handlerToHttpEffect` and its middleware/error boundaries. Only schema factories are shared.
  Request redaction stays in the upstream request handler.
  The reviewed factory body, declarations, and file match are guarded; inspect the complete lifted
  body before updating its fingerprint. Request contexts and handlers remain per Space.
- Direct `baskule:` edits in `serverActivation.ts` park scoped children without a parent handshake.
  `serverRuntimeStartup.ts` exposes recorded recovery failure to the hosted readiness adapter.

The embedded OpenCode 2.2.5 build keeps its provider/catalog guards and Shell-finalizer cleanup.
Its Code Mode inbox-priority adaptation remains as integrated on main; do not restore the 2.1.3 runner.

Both rewrite plugins require every target to be visited. The hosted build treats missing namespace
exports as errors. Run their bundle fixtures, the activation/startup suites, and a minified Space
journey after changes. The startup/retention design is tracked in
[#87](https://github.com/baskule/baskule/issues/87).

### Migration boundary

The application migration head is **116**. The manifest skips 065 (Codex), 070–072
(linked environments), 097, 103 and 109 (issue trackers), 108 (agent feedback),
and 110, 113–115 and 117 (workflows). Preserve recorded IDs and omissions.
A future implementation of an excluded feature must add any required schema
above the then-current head. The migrator skips lower IDs even when absent from
the ledger. Do not add empty migrations or reuse a recorded ID.

Migrations 104–107, 111, 112 and 116 add project and task-folder metadata,
indexes for turn and history reads, worktree layout approval storage, and fork
history membership. The hosted policy limits project mutation to pin and archive.
The client and server compatibility floor remains 0.5.4.

The retention worker physically purges previously deleted chats on its normal
maintenance schedule. Take an installation backup before upgrading. The backup
preserves the previous layout and any deleted chat data that had yet to be
purged.

Schema and data-layout changes need forward migrations for released installations. Changes that
cannot migrate need maintainer approval and documented deployment steps. Operations on an existing
installation, including deployment, restart or data removal, require its operator's authorization.
