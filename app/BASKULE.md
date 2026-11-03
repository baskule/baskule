# Baskule fork of T3 Code

Baskule forks [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT,
Copyright (c) 2026 T3 Tools Inc.; keep `LICENSE`) for a self-hosted agent platform. SpaceCell embeds OpenCode 2,
and tools run on each space's OpenShell computer. See the [project README](../README.md) for the repository layout.

- **Upstream base:** tag `v0.1.6` = `2359643cffa6ba9ee84d6f2694b935de54a8013e`.
- `app/` is tracked in the Baskule umbrella repository. The original fork history and snapshot source are recorded in `../source-provenance.json`.
- Keep generic upstream changes and reapply Baskule's product changes. Retired harnesses stay deleted.

## Agent runtime

Baskule registers exactly one agent driver: OpenCode 2. The SpaceCell deployment embeds 2.1.3. Models from Anthropic,
OpenAI and other vendors run through OpenCode. Local and external OpenCode 2 instances use the
existing ProviderAdapter, driver registry and multi-instance settings contracts. There are no
other bundled provider implementations or OpenCode 1 paths.

Settings keep their generic instance map, so retired driver entries decode but have no executable
driver. Remove those instances and reset their conversations before using this build; they are
not converted to OpenCode. Managed SpaceCell settings are rewritten at boot with OpenCode only,
so an already OpenCode-only deployment needs no data wipe.

## Toolchain

`v0.1.6` pins **Node `26.12.1`** and **pnpm `12.14.0`**. The umbrella uses the same pins in
`../scripts/env.sh`. Run `scripts/worktree setup` from the umbrella root to attach the versioned shared tools
and dependencies. Use `scripts/worktree runtime` when verification needs the SpaceCell bundle.

```sh
source ../scripts/env.sh
```

## Build / run / test (from `baskule/app`)

```sh
CI=1 pnpm install                                                   # ~48 s
node_modules/.bin/vp run --filter @t3tools/web --filter t3 build    # ~61 s -> apps/server/dist/bin.mjs (+ dist/client)

# run headless, from an empty cwd, ALWAYS with an explicit base dir under baskule/.run/
cd ../.run/baseline-cwd && T3CODE_TELEMETRY_ENABLED=false node ../../app/apps/server/dist/bin.mjs serve \
  --host 127.0.0.1 --port 47080 --base-dir "$BASKULE_ROOT/.run/baseline"

(cd packages/provider-opencode && CI=1 pnpm test)
(cd packages/contracts && CI=1 pnpm test)
(cd apps/server && HOME="$BASKULE_ROOT/.run/baseline-testhome" CI=1 node_modules/.bin/vp test run src/auth src/provider)
```

## Original fork patches

The original fork marked upstream-file edits with `// baskule:` comments and preferred new files. Its
pre-consolidation history is retained at the source path recorded in `../source-provenance.json`. Current changes
are tracked in the umbrella history under `app/`.

| Patch                                                                                 | Files                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@opencode/client\|protocol\|schema` 2.0.28 -> **2.1.2** (2.1 compaction wire format) | `packages/provider-opencode/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`; test `v2/OpenCode2Client.compaction.test.ts`                                                                                                                                                                                                                                                                |
| `BASKULE_AUTH_MODE=none`                                                              | new `apps/server/src/auth/BaskuleNoAuth.ts` (+ test); hooks in `SessionStore.ts`, `EnvironmentAuth.ts`                                                                                                                                                                                                                                                                                          |
| Telemetry defaults off when `BASKULE=1` or `BASKULE_AUTH_MODE` is set                 | new `apps/server/src/telemetry/BaskuleTelemetry.ts` (+ test); one line in `AnalyticsService.ts`                                                                                                                                                                                                                                                                                                 |
| Files out: any workspace file as a download                                           | `packages/contracts/src/assets.ts` (`disposition: "attachment"` on `workspace-file`/`draft-workspace-file`); `apps/server/src/assets/AssetAccess.ts` (claim `workspace-file-download`: any type, path-confined like `workspace-file-exact`, `Content-Disposition: attachment`, `application/octet-stream`); `apps/server/src/http.ts` (downloads answer `Range`); test in `AssetAccess.test.ts` |
| Word-level streaming (E2E UX)                                                         | new `apps/server/src/orchestration-v2/BaskuleStreaming.ts` (+ test); hooks in `assistantStreaming.ts` (split function parameter) and `RunExecutionService.ts`. On when `BASKULE=1` or `BASKULE_AUTH_MODE` is set; `BASKULE_STREAMING=paragraph` restores upstream                                                                                                                               |

The 2.1.2 bump needed no source changes (the provider typechecks clean); only compaction lost the required `recent` field.

## No-auth mode (`BASKULE_AUTH_MODE=none`)

- At startup the server persists (or reuses) one owner session, id `baskule-no-auth-owner`, expiry 9999, with
  `BASKULE_NO_AUTH_SCOPES` = standard client scopes **minus** terminal, source-control write, preview, relay, access
  write, providers manage and environment maintain (a terminal here is a shell in the server container).
  Every start resets the row's scopes and clears `revoked_at`, and `verify` ignores revocation for it, so
  no client can lock every device out. No-auth bootstrap grants get the same reduced scopes. It logs a loud `WARN` with the bound host. `0.0.0.0` is allowed (Docker); bind the published port
  to the Tailscale IP only.
- Any HTTP request or WebSocket upgrade whose credential is missing **or unusable** (stale cookie, expired bearer) is
  authenticated as that session, so WebSocket tickets mint and verify normally. Browser requests from a **foreign
  origin** (`Origin` not the server's own host) are still refused (no cross-site use of the open server).
- `POST /api/auth/browser-session` and `POST /oauth/token` (the bootstrap exchange used by `bootstrapRemoteBearerSession`
  on desktop/mobile) accept **any** credential and issue a real session (subject `baskule-no-auth`, 30-day TTL; once
  expired, requests still fall back to the owner session). Android can register `BASKULE_SERVER_URL` with a dummy token.
- Any other value / unset = upstream behavior. The server still prints a pairing URL at startup; ignore it.

```sh
cd ../.run/authtest-cwd && BASKULE_AUTH_MODE=none node ../../app/apps/server/dist/bin.mjs serve \
  --host 127.0.0.1 --port 47310 --base-dir "$BASKULE_ROOT/.run/authtest"
curl -s http://127.0.0.1:47310/api/auth/session      # {"authenticated":true,...} with no cookie
```

## Telemetry

PostHog telemetry (`AnalyticsService`) is on by default upstream. In this fork it defaults **off** when `BASKULE=1` or
`BASKULE_AUTH_MODE` is set; an explicit `T3CODE_TELEMETRY_ENABLED` still wins. Deployments should still set
`T3CODE_TELEMETRY_ENABLED=false` (belt and braces; it also disables relay tracing, `isRelayTracingEnabled`, which reads
only that variable). The web's onboarding text about anonymous usage data is static copy.

## T3 in a celld SpaceCell (`apps/server/src/baskule/workerd/`)

The server runs as one Durable Object per space. `createSpaceServer` (spaceServer.ts) builds
T3's runtime from `server.ts`'s exported layers with workerd edges; the platform's `SpaceCell`
(`../platform/src/space`) owns the cell lifecycle.

```sh
cd apps/server && pnpm build:workerd    # -> dist-workerd/space-cell.js (~10.2 MiB ESM)
HOME=/tmp/t CI=1 node_modules/.bin/vp test run src/baskule src/auth/BaskuleFrontAuth.test.ts
```

| Piece                                                                                                                                                                                                   | Where                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| SqlClient over `ctx.storage.sql`: `storage.transaction` (nested = savepoint), >100 params inlined, compound SELECTs regrouped (recursive CTE aware), tuning PRAGMAs no-ops                              | `workerd/doSqlClient.ts`; hook `persistence/Sqlite.ts` (`InjectedSqlClient`)                                                              |
| FileSystem: T3 home `/baskule/spaces/<id>` in DO SQLite, chat folders as DO records materialized lazily, `/sandbox` via computerd, `/tmp` in memory                                                     | `workerd/fileSystem.ts`, `workerd/computerFs.ts`                                                                                          |
| Raw `node:fs` users (WorkspaceEntries, WorkspaceFileSystem, MediaFile, attachmentStore)                                                                                                                 | seams `baskule/HostFileSystem.ts`, `baskule/attachmentFs.ts` (defaults = Node)                                                            |
| HTTP + WebSocket (`WebSocketPair`), #258 keepalive per socket, route allowlist                                                                                                                          | `workerd/transport.ts`, `workerd/routes.ts`                                                                                               |
| `BASKULE_AUTH_MODE=front` (identity header only; tickets bound to it)                                                                                                                                   | `auth/BaskuleFrontAuth.ts`; hook at the end of `EnvironmentAuth.make`                                                                     |
| RPC + command allowlist                                                                                                                                                                                 | `baskule/rpcPolicy.ts`; hook in `auth/RpcAuthorization.ts`                                                                                |
| No Done inbox: settle commands refused (also through `t3_thread_organize`), settlement capabilities advertised off, auto-settlement disabled                                                            | `baskule/rpcPolicy.ts`, `environment/ServerEnvironment.ts`, `mcp/toolkits/thread/handlers.ts`, `workerd/managedSettings.ts`               |
| Message author (`author` on `message.dispatch`, launch `initialMessage`, messages), stamped at the RPC boundary                                                                                         | `baskule/author.ts`; `ws.ts`, `Orchestrator.ts` (4 sites + steer), `ThreadLaunchService.ts`, contracts                                    |
| Scratch root `/sandbox/space/chats`, webhook base `/hooks/<id>`                                                                                                                                         | `BASKULE_SCRATCH_ROOT` (`ManagedProjectFolders.ts`), `BASKULE_WEBHOOK_BASE` (`server.ts`)                                                 |
| Node shims, OpenCode-only driver list                                                                                                                                                                   | `workerd/shims/`, `workerd/trim/` (aliased by `workerd/build.mjs`, the only place)                                                        |
| Trimmed host modules: terminals, devices, local preview browser                                                                                                                                         | `workerd/trim/*.ts` (stub = same exports and service keys, inert), listed in `TRIM` in `workerd/build.mjs`                                |
| Heap attribution sampler available only on Node                                                                                                                                                         | `observability/HeapAttribution.ts`: guard V8 sampler availability; retain the tracer in workerd                                           |
| Hosted feature capabilities                                                                                                                                                                             | `environment/ServerEnvironment.ts`: `sideChats` follows the `thread.fork` command policy; `projectOrganization` follows `projects.mutate` |
| Project organization guard                                                                                                                                                                              | `baskule/rpcPolicy.ts`: `projects.mutate` accepts only pin/archive project updates                                                        |
| MCP toolkits filtered by the space policy before registration; in a cell they register on the first `/mcp` request                                                                                      | `mcp/McpHttpServer.ts`, `baskule/mcpDeferredRegistrations.ts`                                                                             |
| New chat start: the title is queued when the run leaves "starting" (not with the message); a run that starts right away counts its work from the send (`workStartedAt`); no git probe after each answer | `baskule/newChatStart.ts`; `Orchestrator.ts` (2 sites), `ProviderTurnStartService.ts`, `RunFinalizationService.ts`                        |

Merge notes: every upstream-file edit carries `// baskule:`. A trim stub mirrors the exports its importers use and the
real service key; when upstream changes such a module's API, the bundle build fails (missing export) or the runner
fails (missing method). After an upstream merge, rebuild the bundle and run
`../platform/src/space/test/run.mjs` (a new top-level `createRequire`/`net`/`tty` use or a query beyond DO SQLite's
limits shows up there first).

## Updating from upstream

Start each upgrade on a branch based on `origin/main` in `baskule/baskule`. Compare the current upstream tag
with the next stable tag in a separate upstream clone, and apply that delta as a normalized three-way merge
against the `app/` tree. Do not merge the upstream repository at the umbrella root. Retired files and new files
under retired provider directories stay deleted. Audit the result against the paths removed from the public
source set; never fetch or compare the archived private repository. The publication audit is reproducible:

```sh
node app/scripts/audit-upstream-paths.mjs /path/to/upstream v0.1.5 v0.1.6 1d141ae37
```

It checks both previously deleted files touched upstream and new files under directories the fork retired.
Use the next upgrade's base tag, target tag and starting Baskule commit.

### Deliberately stripped upstream features

Baskule does not include the upstream marketing site or its Vercel release jobs. Native packaging stages
the generic runtime dependencies; retired Cursor and Claude SDK staging stays deleted.
Forge adapters and their Node registry, PR APIs/workers/MCP tools, publishing and review UI are removed.
Generic Git clone/commit/push/worktrees and local diffs remain. Stored PR metadata, migrations,
search/replay helpers and legacy credential redaction remain compatible with released data.

| Feature                            | Removed surfaces                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linked environments                | `apps/server/src/peer/`, peer-link contracts and RPCs, environment linking MCP tools and tool routing parameters, remote delegation, linked-machine mentions and thread chips, and web/mobile linked-environment sections |
| Linked-environment database layout | `070_PeerLinks`, `071_PeerLinkFence`, `072_WaitingLinkRequestIndex`, and their peer-only migration-head/fence protocol                                                                                                    |
| Issue triage                       | `apps/server/src/triage/`, triage CLI commands, palette actions, draft hero, and mobile triage entry points                                                                                                               |
| Developer servers and scanning     | `apps/server/src/preview/PortScanner.ts`, terminal process-registration hooks, discovery RPC, local-server cards and the thread servers panel                                                                             |
| Simlock product integration        | Device-service pool adapters, contracts and RPCs, Simlock-only mobile runners, and their development probe; local devices remain subject to the SpaceCell trim                                                            |
| GitHub app sign-in                 | `SourceControlSignIn`, `GitHubAppSignIn`, sign-in RPCs and settings; Git uses machine credentials and saved forge secrets remain redacted                                                                                 |
| T3 commercial additions            | Tunnel plans and usage, T3 Chat account upsell, and fleet-wide Stable/Nightly switching                                                                                                                                   |
| Upstream update notes              | The v0.1.5 popover addition resolves to upstream T3 release URLs. Locally generated channel artwork stays                                                                                                                 |
| Mobile telemetry                   | `apps/mobile/src/features/observability/`, crash SDK, sourcemap upload scripts/workflow step, public tracing configuration and relay mobile-ingest credentials                                                            |
| Retired UI layouts                 | Legacy sidebar and its settings flag, new-design toggle, and the desktop collapsed-controls state                                                                                                                         |

Generic environment pairing and Connections stay available to native clients. Labs stays for the remaining
settings. The project-folder sidebar is an opt-in; Baskule's chat sidebar remains the default. The composer uses
upstream's grouped controls and effort labels with Baskule voice input and localization. Generic usage-limit
fallback is retained; the OpenCode v2 adapter does not implement provider fallback itself.

### Filtered v0.1.3 → v0.1.5 PRs

These upstream PRs were reversed or filtered by owner decision. Generic follow-up fixes in the
same hunks remain applicable; a feature revert is never authority to discard them.

| Owner decision                              | Upstream PRs                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| No linked environments or remote delegation | #16653, #16655, #16684, #16695, #16698, #16719, #17129, #17130, #26143, #26201, #26202, #26239, #26434 |
| No issue triage                             | #22753                                                                                                 |
| No developer servers panel or port scanner  | #22542                                                                                                 |
| No Simlock pool                             | #25259, #26706                                                                                         |
| No GitHub-app sign-in                       | #26245                                                                                                 |
| No T3 Connect plans/usage                   | #25931, #26366, #26369                                                                                 |
| No fleet Stable/Nightly switch              | #26288                                                                                                 |
| No upstream release-note popover            | #26893                                                                                                 |
| No mobile Axiom crash reporting             | #19093                                                                                                 |

Keep the `t3_thread_interrupt` `stop` option from #16684: it provides the retained local full-Stop
operation (running turn, queue, watches and delegated tasks), covered by MCP Stop behavior tests.
T3-Mode-Limit from #16653 is removed with linked environments.

**Keep #26917 and #26921:** these make ordinary Update Everything wait for npm only when
needed and test the exact archive-install version floor. They do not require fleet switching.
The [filter conflict audit](../docs/upstream/t3-0.1.5-filter-audit.md) records all 41 overlap records
from this upgrade and the independent changes retained from them.

### Filtered v0.1.5 → v0.1.6 PRs

Keep the generic delta, including side chats (#26901), project pin/archive (#26154), Stop and force stop
(#27252, #27141), local-commit review (#19941), server and web performance work, OpenCode fixes
(#23591, #23598, #24734, #25230, #26165), and redaction/tracing fixes (#27986, #27904, #24556).
The 2.1.2 schema contains `message.time.streamed`, so #23591 needs no protocol adaptation.
The four-reader SQLite pool stays on Node. SpaceCell still injects one shared DO SQL client.
Heap attribution from #27104 runs on Node; workerd has no `v8.getHeapStatistics`, so the cell keeps its
existing tracer without that sampler. The browser and terminal workerd stubs track the new scoped
profile reporter and shell lookup APIs. Side chats, pin/archive, Stop and force stop run in the cell;
local-commit review remains a native Node capability because the cell has no Git process spawner.

| Owner decision                                                            | Upstream PRs                   |
| ------------------------------------------------------------------------- | ------------------------------ |
| No external secret-provider packages or `op` CLI dependency               | #25709, #27044, #27115, #27746 |
| No Stable/Nightly npm release lookup (generic self-update fixes retained) | #27847                         |
| No GitHub star prompt                                                     | #27832                         |
| No linked environments                                                    | #26567, #27313                 |
| No issue triage                                                           | #24955                         |
| No dev-server discovery or port scanner                                   | #27893                         |
| No T3 Connect commercial plans and usage                                  | #27442                         |

Generic changes in overlapping hunks remain. The [v0.1.6 filter audit](../docs/upstream/t3-0.1.6-filter-audit.md)
records each conflict and the hosted RPC decisions. Retired provider paths remain absent.
Remove inherited browser assertions for ACP registry images and the upstream release-note popover;
generic model-picker and Update Everything tests remain.
Desktop release-note parsing (#24358) and EAS device fixes (#26797) remain generic retained code.

### Reproduce the filtered merge

`app/scripts/filter-upstream.py` takes explicit clone, version and output arguments. It clones
only local upstream objects into a disposable checkout, removes its push remote, reverses the
selected PR commits newest first, and stops with Git's three-stage conflicts intact. It never
chooses the pre-feature side automatically. For example, from the umbrella root:

```sh
python3 app/scripts/filter-upstream.py --upstream /path/to/t3code \
  --from-ref v0.1.5 --to-ref v0.1.6 --output .run/filtered-t3 \
  --exclude-pr 25709 --exclude-pr 27044 --exclude-pr 27115 --exclude-pr 27746 \
  --exclude-pr 27832 --exclude-pr 26567 --exclude-pr 27313 --exclude-pr 24955 \
  --exclude-pr 27893 --exclude-pr 27442
# #27847: remove only the stripped track-switch lookup after merging; keep its generic fixes.
```

Exit 2 means review is required. In that checkout, inspect `git diff --cc`, `git show :1:path`,
`:2:path` and `:3:path`. Remove only the selected feature, retain independent later fixes,
`git add` the resolution, then `git -c gc.auto=0 revert --continue`. Repeat until the sequencer
finishes. `.git/baskule-filter.json` records the input SHAs, selected commits and initial conflicts.
Review the resulting tree and commit any staged resolutions before merging it into Baskule. The reversals
filter the version delta; apply the owner exclusions above to older baseline code too, including
port discovery and mobile tracing. Those older paths are not introduced by the reversed PRs.

For each changed path, the three inputs are the starting Baskule commit's `app/<path>`, the old
upstream tag's `<path>`, and the reviewed filtered target's `<path>`, in that order. Normalize
all three with the pinned `vp fmt --stdin-filepath <path>` before `git merge-file -p --diff3`.
Keep upstream-deleted files deleted; keep Baskule-deleted old files and new files under retired
provider/feature directories deleted. Review add/add, modify/delete and binary changes explicitly;
copy modes from the target for retained upstream executables. Save every conflicted hunk and its
reason before editing. Regenerate lockfiles from the reviewed manifests.

### Migration boundary

Baskule's migration head is **076**. Migrations 073–076 add active-turn indexes, repair search triggers,
index subagent delivery state, and add project pin/archive columns. They use Baskule's existing schema and
require no data wipe. Baskule has never shipped peer-only migrations 070–072. Their ids stay absent.
On the next upgrade, inspect migrations after 076 for peer tables, fences, indexes, and migration-head assumptions.
Do not add empty migrations for retired layouts. Keep compatibility code within the declared release window.
Ship forward migrations for schema and data-layout changes. A change that cannot be migrated needs the owner's
explicit approval and documentation of affected data and deployment steps. Operating an installation requires its owner's authorization.

### Next-upgrade checklist

1. Read this fork inventory and compare all upstream changes to its hooks: no-auth, telemetry defaults, downloads,
   authorship, word streaming, managed settings, admin model labels, Settings modal, account menu and branding.
2. Keep deleted harnesses and OpenCode v1 deleted. Recheck mode changes on an existing OpenCode v2 session; its
   policy applies each turn. Device prompt guidance must follow the MCP session's actual device capability.
3. Audit `server.ts`, `ws.ts`, `Orchestrator.ts`, the MCP toolkits, and workerd `TRIM`. No peer, triage, port scanner,
   simulator pool or GitHub app sign-in layer may enter the SpaceCell graph. Keep the shared SQL client,
   multiplexed alarm and same-cell agent request.
4. Apply the migration boundary above before building. Preserve generic fixes, security changes and licences;
   sync third-party notices whenever dependency manifests or the lockfile change.
5. Diff `apps/server/src/baskule/rpcPolicy.ts` against the starting Baskule commit and compare every
   removed/renamed method with the target's `packages/contracts/src/rpc.ts` and orchestration contracts.
   Audit replacements and actual web/mobile callers, not name prefixes. Grep the `platform/` harnesses for
   removed RPC method names too. Extend the hosted-policy behavior
   test, then run `scripts/check space`, including bounded/deferred history and restart questions.
6. Extract and check catalogs. Translation generation needs explicit credentials and is separate from local builds.
7. Run affected lint, typechecks and tests, frozen install, SpaceCell/web builds and a disposable fake-LLM journey.
   Record bundle bytes and retain evidence under `.run/evidence/`. Stop the disposable stack. Native packages need
   their own platform verification; deployment and wipes require the installation owner's authorization.

## Pitfalls

- **Never run against `~/.t3/userdata`** (the live T3 install on this machine). Always pass `--base-dir` under `baskule/.run/`.
- **Telemetry is on by default upstream** (off here only with `BASKULE=1`/`BASKULE_AUTH_MODE`): always set
  `T3CODE_TELEMETRY_ENABLED=false` (env.sh does).
- Before the first start, configure only the intended OpenCode instance in `<base-dir>/userdata/settings.json`.
- Run server tests with a throwaway `HOME`; the full `apps/server` suite takes > 9 min, so use path subsets.
- Vitest with `CI=1` prints only the final summary (no per-file progress).
- Never set `VITE_HTTP_URL`/`VITE_WS_URL` (bakes origins into the bundle).
- Pairing token is single-use; browsers keep a session cookie.

## UI patches

All web UI reductions go through **`apps/web/src/baskule/flags.ts`** (`baskule.skipFirstRun`, `flatChatSidebar`,
`plainChat`, `hideSettings`, `hiddenFileTreeEntries`). Build with `VITE_BASKULE_UI=0` to get the upstream T3 Code UI
back. Every touched upstream line carries an `// baskule:` comment (`git grep -n "baskule:" apps/web`). Nothing is
deleted. New code only lives in `apps/web/src/baskule/`.

| Area                                       | Patch (file)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-run wizard never shown               | `routes/__root.tsx` (FirstRunGate `enabled=false`); `/welcome`, `/usage` and T3's settings pages redirect to `/` (`routes/welcome.tsx`, `usage.tsx`, `settings.tsx`); `/settings` holds Baskule's own sections (`baskule/settingsPages.ts`)                                                                                                                                                                                                                                                                             |
| `/` = new chat                             | `routes/_chat.index.tsx` -> `baskule/BaskuleIndexLanding.tsx` (draft in the scratch project; shows progress, retries a failed start with backoff, "Try again"). After the first send the URL moves from `/draft/<id>` to `/<env>/<thread>` (upstream promotion; it lands shortly after the message renders)                                                                                                                                                                                                             |
| New chat -> scratch ("No project") project | `baskule/useBaskuleNewChat.ts` (`openScratch` = server `ensureScratchProject`, then `useNewThreadHandler`); used by the sidebar button                                                                                                                                                                                                                                                                                                                                                                                  |
| Chat list                                  | `components/Sidebar.tsx`: slim rows, pinned chats first then the rest most-recent-first, drag to pin/unpin/reorder, Snoozed shelf; no favicon/PR/terminal/hover card; no Settled shelf when the space advertises no `threadSettlement` (`ServerEnvironment.ts`); status glyph (`baskule/BaskuleChatStatus.tsx`) and a `...` button opening the chat menu                                                                                                                                                                |
| Chat menu = Rename / Archive / Delete      | `baskule/threadMenu.ts`, applied once inside `components/threadActionMenu.logic.ts` (`buildThreadActionMenuItems`), so the sidebar, header and every other caller get it                                                                                                                                                                                                                                                                                                                                                |
| Sidebar header/footer                      | `sidebar/SidebarThreadHeader.tsx` is a 3-line wrapper rendering `baskule/BaskuleSidebarHeader.tsx` ("New chat" + "Search chats"); `sidebar/SidebarChrome.tsx` ("Baskule" text brand; footer = the account menu (Settings, Admin, Sign out); no PRs/usage/update pills); `AppSidebarLayout.tsx` keeps the chat list on `/settings/archived`                                                                                                                                                                              |
| Composer                                   | `chat/ChatComposer.tsx`: no model/provider/runtime-mode/plan controls (chats use the installation's one model); slash menu = the agent's configured commands and skills (`/plan` needs the hidden plan-mode setting); placeholder "Message Baskule"; provider-down copy "The assistant's computer is unavailable, retrying…" and a re-probe every 8 s while down (`baskule/composer.ts`, `baskule/useProviderRetry.ts`); `chat/DraftHeroHeadline.tsx`: "What can I help with?"                                          |
| Chat header                                | `chat/ChatHeader.tsx` (no project breadcrumb); `chat/PanelLayoutControls.tsx` (no terminal toggle); `chat/ThreadDetailsPanel.tsx`: the thread-details panel shows the chat's automations and forks/merge-back only (no machine/"Open in"/scripts/git); `ChatView.tsx` (right panel opens straight on Files); `RightPanelTabs.tsx` (action lists filtered to Files and Side chat, plus hosted Browser, by `baskule/rightPanel.ts`; Side chat matches its translated label); `ChatView.logic.ts` (draft title "New chat") |
| Files                                      | `files/useDirectoryEntries.ts` hides `.playwright-mcp`; `files/FilePreviewPanel.tsx`: **Download file** for every previewed file and a "can't be previewed — Download" body for binary files (`baskule/WorkspaceFileDownload.tsx`, signed `/api/assets` URL with `disposition: "attachment"`, see below); no empty "Open in" picker; on a phone the tree starts collapsed when a file is open                                                                                                                           |
| Archived view                              | `settings/SettingsPanels.tsx` (group titled "Archived chats", no project icon), `settings/settingsLayout.tsx` (no scope sentence), `routes/settings.tsx` (header "Archived chats")                                                                                                                                                                                                                                                                                                                                      |
| Keyboard / palette                         | `keybindings.ts` ignores bindings outside `baskule/keybindings.ts` (new chat, sidebar, right panel, thread details, find, stop, thread nav/jump, queue, stash): no terminal, diff, preview, palette, model picker, pin/settle, editors. `commandPaletteBus.ts`: the palette never opens (no "Add project")                                                                                                                                                                                                              |
| "chat" copy                                | `baskule/copy.ts` rewrites thread→chat in confirm dialogs (`confirmDialog.ts`), toasts (`components/ui/toast.tsx`) and the sidebar/archived empty states                                                                                                                                                                                                                                                                                                                                                                |
| Rebrand                                    | `branding.ts` (`APP_BASE_NAME` = Baskule, stage "Alpha"); static, not flag-driven: `index.html` (title, text splash instead of the T3 logo), `public/manifest.webmanifest`, `lib/bootError.ts`. `branding.test.ts` follows `APP_BASE_NAME`.                                                                                                                                                                                                                                                                             |

Kept as upstream: streamed messages + tool-call timeline, user-input question forms, approvals, files panel /
preview / download, search, rename, phone drawer sidebar.

Tests: the web vitest projects run with `VITE_BASKULE_UI=0` unless the variable is set (`apps/web/vite.config.ts`),
so upstream suites test upstream behavior; `src/baskule/*.test.ts` stub the flag on (`vi.stubEnv` + `vi.resetModules`).

Known gaps: provider error banners are upstream's; mobile strings still say "thread"
(≈180 strings, no seam); mobile has no file download.

## Context compaction (automatic only)

OpenCode 2 compacts on its own (`compaction.auto` defaults to on): before each model step it summarizes the
conversation once the context reaches the model's window minus max(15 %, 16k) tokens, and once more if the provider
rejects a request as too long; the turn then continues. Set each model's context window to its real limit in **Admin → AI → Models**; an incorrect limit can delay compaction until a
provider rejection. The OpenCode 2 adapter maps `session.compaction.*` to a `compaction` turn item, which web and mobile draw
as a "Context compacted" divider in the turn (fixture `testkit/fixtures/opencode2_compaction`).

Compaction is automatic. There is no manual `/compact` action, provider compaction hook, or idle compaction worker.

## Hosted web client

Hosted multi-user build: `VITE_BASKULE_HOSTED=1`.
Dev loop: `apps/web/baskule-dev/` (`./check.sh`).

| Area                                               | Patch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base path (upstreamable, root behaviour unchanged) | `client-runtime/environment/endpoint.ts`: `environmentEndpointUrl` joins under the base path, `environmentSocketUrl` (`<base>/ws`), `resolveEnvironmentRelativeUrl` (server URLs under the base path unless already prefixed); used by `authorization/remote.ts`, `connection/resolver.ts`, `connection/presentation.ts` (`/mcp`), `rpc/http.ts` (API base keeps the path), `state/assets.ts` (`resolveAssetUrl`), `webhookAddress.ts`; `shared/remote.ts` and `shared/advertisedEndpoint.ts` keep a base path (a pairing link's directory is the backend); `onboarding.ts` bearer ids include a non-root path |
| Hosted mode                                        | `hostedPairing.ts` (`isHostedStaticApp` true); `connection/platform.ts` uses `baskule/spaces.ts` as the platform source: one `PrimaryConnectionRegistration` per space at `<origin>/s/<id>/` (same-origin cookie auth, no pairing), labels = space names, Personal first (= the app's primary environment), re-read on focus / every 60 s / after space changes                                                                                                                                                                                                                                                |
| Sign-in gate                                       | `routes/__root.tsx` → `baskule/root.tsx` (`GET /api/baskule/me`; 401 → `/login?next=`; bare `/login`, `/invite`, `/reset-password`, `/setup`); local storage cleared on sign-out and when another person signs in on the browser (`baskule/session.ts`)                                                                                                                                                                                                                                                                                                                                                        |
| New views                                          | routes `login`, `invite` (`#token=`), `reset-password`, `setup` (first admin, `#token=`), `admin` (people + invitations, spaces, health), `apps` (desktop downloads, linked to the version's GitHub release assets); `baskule/SpaceManagementDialog.tsx` (team space members/roles/rename/delete, new team space); `baskule/BaskuleUserMenu.tsx` in the sidebar footer (spaces you manage, admin, desktop app, change password, sign out); API client `baskule/api.ts` against the platform's `/api/baskule`                                                                                                   |
| Authorship                                         | contracts `OrchestrationV2Author` (optional `author` on creation fields); `session-logic.ts`, `types.ts`; `MessagesTimeline.tsx` names other people's messages (`baskule/authorship.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Spaces in the UI                                   | `Sidebar.tsx` row label (`baskule/BaskuleSpaceLabel.tsx`, shown with 2+ spaces); the composer's "Run on" picker lists the spaces (upstream); connection banners say "Acme did not answer" (`baskule/copy.ts`, `ConnectionDiagnosisDetails.tsx`)                                                                                                                                                                                                                                                                                                                                                                |
| Controls available in hosted mode                  | chat menu: Pin, Snooze, Mark unread (`baskule/threadMenu.ts`); sidebar: pinned first, snoozed last, unread dot and weight (`Sidebar.tsx`, `BaskuleChatStatus.tsx`); `/settings/scheduled-tasks` + footer link (`baskule/settingsPages.ts`, `routes/settings.tsx`, `SidebarChrome.tsx`); shared Browser and Side chat surfaces in the right panel (`baskule/rightPanel.ts`)                                                                                                                                                                                                                                     |
