# Baskule fork of T3 Code

This repo is the Baskule Alpha 0.1 product fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT,
Copyright (c) 2026 T3 Tools Inc.; keep `LICENSE`). Baskule is a ChatGPT-like assistant UI driving OpenCode 2 inside a
sleepable "computer" container. See the [project README](../README.md) for the current repository layout.

- **Upstream base:** tag `v0.1.1` = `fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92`.
- **Branch:** `baskule/main` = `v0.1.1` + our patches as commits. Remote `upstream` only (no `origin` yet).
- Strategy: configuration first, small patches, no deletions (keep merges cheap).

## Agent runtime

Baskule registers exactly one agent driver: OpenCode 2. The SpaceCell deployment embeds 2.1.3. Models from Anthropic,
OpenAI and other vendors run through OpenCode. Local and external OpenCode 2 instances use the
existing ProviderAdapter, driver registry and multi-instance settings contracts. There are no
other bundled provider implementations or OpenCode 1 paths.

Settings keep their generic instance map, so retired driver entries decode but have no executable
driver. Remove those instances and reset their conversations before using this build; they are
not converted to OpenCode. Managed SpaceCell settings are rewritten at boot with OpenCode only,
so an already OpenCode-only deployment needs no data wipe.

## Toolchain (v0.1.1 pins, NOT main's)

`v0.1.1` requires **Node `^24.13.1`** (`engines`) and **pnpm `11.10.0`** (`packageManager`). Upstream `main` has since moved
to Node 26.12.1 + pnpm 12; re-check `package.json` at every upstream merge and update `../scripts/env.sh`.

User-local: Node 24.22.1 in `baskule/.tools/node-v24.22.1-linux-x64`, pnpm via that Node's corepack shim in `baskule/.tools/bin`.

```sh
source baskule/scripts/env.sh
# = export PATH="$BASKULE_ROOT/.tools/bin:$BASKULE_ROOT/.tools/node-v24.22.1-linux-x64/bin:$PATH"
#   export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 T3CODE_TELEMETRY_ENABLED=false
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

## Baseline (v0.1.1, unpatched, 2026-10-22, host "nas", 4 cores)

| Suite                                      | Result                                                                          | Duration |
| ------------------------------------------ | ------------------------------------------------------------------------------- | -------- |
| packages/provider-opencode                 | 16 files passed, 2 skipped; 228 tests passed, 2 skipped                         | 34 s     |
| packages/contracts                         | 39 files passed; 695 tests passed                                               | 15 s     |
| apps/server subset `src/auth src/provider` | 70 files passed; 1071 tests passed                                              | 226 s    |
| apps/server full (462 files)               | not completed: killed by a 9 min timeout (CI mode prints nothing until the end) | > 9 min  |

Smoke: built server with `--base-dir baskule/.run/baseline` on 127.0.0.1:47080 -> `GET /` 200 (`<title>T3 Code (Beta)</title>`)
4 s after start, then stopped.

## Patches on `baskule/main`

Every upstream-file edit carries an `// baskule:` comment; new files are preferred. `git log v0.1.1..baskule/main` is the
authoritative list.

| Patch                                                                                        | Files                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@opencode/client\|protocol\|schema` 2.0.28 -> **2.1.2** (D2/B2: 2.1 compaction wire format) | `packages/provider-opencode/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`; test `v2/OpenCode2Client.compaction.test.ts`                                                                                                                                                                                                                                                                |
| `BASKULE_AUTH_MODE=none` (D7/B5)                                                            | new `apps/server/src/auth/BaskuleNoAuth.ts` (+ test); hooks in `SessionStore.ts`, `EnvironmentAuth.ts`                                                                                                                                                                                                                                                                                         |
| Telemetry defaults off when `BASKULE=1` or `BASKULE_AUTH_MODE` is set                      | new `apps/server/src/telemetry/BaskuleTelemetry.ts` (+ test); one line in `AnalyticsService.ts`                                                                                                                                                                                                                                                                                                |
| Headless settings template (B3)                                                              | `baskule/settings.template.json`                                                                                                                                                                                                                                                                                                                                                               |
| Files out (review M7): any workspace file as a download                                      | `packages/contracts/src/assets.ts` (`disposition: "attachment"` on `workspace-file`/`draft-workspace-file`); `apps/server/src/assets/AssetAccess.ts` (claim `workspace-file-download`: any type, path-confined like `workspace-file-exact`, `Content-Disposition: attachment`, `application/octet-stream`); `apps/server/src/http.ts` (downloads answer `Range`); test in `AssetAccess.test.ts` |
| Word-level streaming (E2E UX)                                                                | new `apps/server/src/orchestration-v2/BaskuleStreaming.ts` (+ test); hooks in `assistantStreaming.ts` (split function parameter) and `RunExecutionService.ts`. On when `BASKULE=1` or `BASKULE_AUTH_MODE` is set; `BASKULE_STREAMING=paragraph` restores upstream                                                                                                                           |

The 2.1.2 bump needed no source changes (the provider typechecks clean); only compaction lost the required `recent` field.

## No-auth mode (`BASKULE_AUTH_MODE=none`)

- At startup the server persists (or reuses) one owner session, id `baskule-no-auth-owner`, expiry 9999, with
  `BASKULE_NO_AUTH_SCOPES` = standard client scopes **minus** terminal, source-control write, preview, relay, access
  write, providers manage and environment maintain (review M1: a terminal here is a shell in the server container).
  Every start resets the row's scopes and clears `revoked_at`, and `verify` ignores revocation for it (review M5), so
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

Verified 2026-10-22: `/`, `/api/auth/session`, `/api/auth/clients`, `/api/projects`, `/api/auth/websocket-ticket` -> 200
without credentials; cross-origin -> 401; `/oauth/token` with `subject_token=dummy` -> Bearer token that authenticates;
headless Chrome with no pairing token gets an authenticated session and an open `/ws` (environment "Connected").
The first-run wizard still shows in this baseline (that is the UI patch). Restart reuses the
session row.

## Telemetry

PostHog telemetry (`AnalyticsService`) is on by default upstream. In this fork it defaults **off** when `BASKULE=1` or
`BASKULE_AUTH_MODE` is set; an explicit `T3CODE_TELEMETRY_ENABLED` still wins. Deployments should still set
`T3CODE_TELEMETRY_ENABLED=false` (belt and braces; it also disables relay tracing, `isRelayTracingEnabled`, which reads
only that variable). The web's onboarding text about anonymous usage data is static copy.

## Headless settings (`baskule/settings.template.json`, B3)

Render to `<baseDir>/userdata/settings.json` before start (`${VAR}` placeholders). Keys, verified against
`packages/contracts/src/settings.ts` and a real start:

- `providerInstances.opencode = { driver: "opencode", enabled: true, config: { serverUrl, serverPassword } }`
  (`packages/provider-opencode/src/settings.ts`). Only OpenCode 2 is registered, and its instances are disabled until configured. On load the server moves a plaintext `serverPassword` into `userdata/secrets/` and rewrites the file
  with a redacted marker, so re-rendering on every start is fine and keeps the secret in sync.
- `defaultModelSelection` and `textGenerationModelSelection` = `{ instanceId: "opencode", model: "<providerID>/<modelID>" }`
  (an OpenCode model slug). Options can be
  omitted; OpenCode reasoning variants use option id `variant`.
- Variables: `BASKULE_OPENCODE_URL` (e.g. `http://baskule-computerd:4096`), `BASKULE_OPENCODE_PASSWORD`,
  `BASKULE_LLM_PROVIDER_ID` (provider key in the computer's `opencode.jsonc`), `BASKULE_LLM_MODEL`.
- **Catalog restriction:** T3 lists every model OpenCode's `model.list` returns (`openCode2Catalog.ts`); restricting in
  OpenCode suffices. OpenCode 2.1.2 config: `"policies": [{"action":"provider.use","resource":"*","effect":"deny"},
{"action":"provider.use","resource":"<providerID>","effect":"allow"}]` (V1 `enabled_providers: ["<providerID>"]` is
  normalized to exactly that, `core/src/config/normalize.ts`); denied providers are removed from the catalog
  (`core/src/config/plugin/policy.ts`). Verified in source, not yet by running.
- **Auth to OpenCode:** the external-server driver sends `Authorization: Basic base64("opencode:<password>")` (UTF-8) as a
  **header** on every request, including `GET /api/event` (`v2/OpenCode2Client.ts`), never a query parameter, so a reverse
  proxy forwards it unchanged.

## Tests after the patches (2026-10-22)

| Suite                                                    | Result                                                  |
| -------------------------------------------------------- | ------------------------------------------------------- |
| packages/provider-opencode                               | 17 files passed, 2 skipped; 230 tests passed, 2 skipped |
| packages/contracts                                       | 39 files passed; 695 tests passed                       |
| apps/server subset `src/auth src/provider src/telemetry` | 77 files passed; 1106 tests passed                      |
| typecheck `packages/provider-opencode`, `apps/server`    | clean                                                   |

## 0.2: T3 in a celld SpaceCell (`apps/server/src/baskule/workerd/`)

The server runs as one Durable Object per space (architecture v3 E2/E8). `createSpaceServer` (spaceServer.ts) builds
T3's runtime from `server.ts`'s exported layers with workerd edges; the platform's `SpaceCell`
(`../platform/src/space`) owns the cell lifecycle.

```sh
cd apps/server && pnpm build:workerd    # -> dist-workerd/space-cell.js (~9.5 MiB ESM; --minify: ~4.8 MiB, names kept)
HOME=/tmp/t CI=1 node_modules/.bin/vp test run src/baskule src/auth/BaskuleFrontAuth.test.ts
```

| Piece                                                                                                                                                                      | Where                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| SqlClient over `ctx.storage.sql`: `storage.transaction` (nested = savepoint), >100 params inlined, compound SELECTs regrouped (recursive CTE aware), tuning PRAGMAs no-ops | `workerd/doSqlClient.ts`; hook `persistence/Sqlite.ts` (`InjectedSqlClient`)                                                 |
| FileSystem: T3 home `/baskule/spaces/<id>` in DO SQLite, chat folders as DO records materialized lazily, `/sandbox` via computerd v2, `/tmp` in memory                    | `workerd/fileSystem.ts`, `workerd/computerFs.ts`                                                                             |
| Raw `node:fs` users (WorkspaceEntries, WorkspaceFileSystem, MediaFile, attachmentStore)                                                                                    | seams `baskule/HostFileSystem.ts`, `baskule/attachmentFs.ts` (defaults = Node)                                             |
| HTTP + WebSocket (`WebSocketPair`), #258 keepalive per socket, route allowlist                                                                                             | `workerd/transport.ts`, `workerd/routes.ts`                                                                                  |
| `BASKULE_AUTH_MODE=front` (identity header only; tickets bound to it)                                                                                                     | `auth/BaskuleFrontAuth.ts`; hook at the end of `EnvironmentAuth.make`                                                       |
| RPC + command allowlist                                                                                                                                                    | `baskule/rpcPolicy.ts`; hook in `auth/RpcAuthorization.ts`                                                                  |
| No Done inbox: settle commands refused (also through `t3_thread_organize`), settlement capabilities advertised off, auto-settlement disabled                               | `baskule/rpcPolicy.ts`, `environment/ServerEnvironment.ts`, `mcp/toolkits/thread/handlers.ts`, `workerd/managedSettings.ts` |
| Message author (`author` on `message.dispatch`, launch `initialMessage`, messages), stamped at the RPC boundary                                                            | `baskule/author.ts`; `ws.ts`, `Orchestrator.ts` (4 sites + steer), `ThreadLaunchService.ts`, contracts                      |
| Scratch root `/sandbox/space/chats`, webhook base `/hooks/<id>`                                                                                                            | `BASKULE_SCRATCH_ROOT` (`ManagedProjectFolders.ts`), `BASKULE_WEBHOOK_BASE` (`server.ts`)                                  |
| Node shims, OpenCode-only driver list                                                                                                                                      | `workerd/shims/`, `workerd/trim/` (aliased by `workerd/build.mjs`, the only place)                                           |
| Trimmed host modules (0.2.1): terminals, devices, local preview browser, source-control drivers                                                                            | `workerd/trim/*.ts` (stub = same exports and service keys, inert), listed in `TRIM` in `workerd/build.mjs`                   |
| MCP toolkits filtered by the space policy before registration; in a cell they register on the first `/mcp` request                                                         | `mcp/McpHttpServer.ts`, `baskule/mcpDeferredRegistrations.ts`                                                               |
| New chat start: the title is queued when the run leaves "starting" (not with the message); a run that starts right away counts its work from the send (`workStartedAt`); no git probe after each answer | `baskule/newChatStart.ts`; `Orchestrator.ts` (2 sites), `ProviderTurnStartService.ts`, `RunFinalizationService.ts` |

Merge notes: every upstream-file edit carries `// baskule:`. A trim stub mirrors the exports its importers use and the
real service key; when upstream changes such a module's API, the bundle build fails (missing export) or the runner
fails (missing method). After an upstream merge, rebuild the bundle and run
`../platform/src/space/test/run.mjs` (a new top-level `createRequire`/`net`/`tty` use or a query beyond DO SQLite's
limits shows up there first).

## Updating from upstream

The clone is **blobless** (`--filter=blob:none`): full commit history, file contents fetched on demand, so merges work.

```sh
git fetch upstream tag v0.1.2 --no-tags     # or: git fetch upstream --tags
git merge v0.1.2                            # on baskule/main; resolve, re-run the baseline tests above
```

## Pitfalls

- **Never run against `~/.t3/userdata`** (the live T3 install on this machine). Always pass `--base-dir` under `baskule/.run/`.
- **Telemetry is on by default upstream** (off here only with `BASKULE=1`/`BASKULE_AUTH_MODE`): always set
  `T3CODE_TELEMETRY_ENABLED=false` (env.sh does).
- Before the first start, configure only the intended OpenCode instance in `<base-dir>/userdata/settings.json`.
- Run server tests with a throwaway `HOME`; the full `apps/server` suite takes > 9 min, so use path subsets.
- Vitest with `CI=1` prints only the final summary (no per-file progress).
- Never set `VITE_HTTP_URL`/`VITE_WS_URL` (bakes origins into the bundle).
- Pairing token is single-use; browsers keep a session cookie.

## UI patches (branch `baskule/ui`, D13 / B7)

All web UI reductions go through **`apps/web/src/baskule/flags.ts`** (`baskule.skipFirstRun`, `flatChatSidebar`,
`plainChat`, `hideSettings`, `hiddenFileTreeEntries`). Build with `VITE_BASKULE_UI=0` to get the upstream T3 Code UI
back. Every touched upstream line carries an `// baskule:` comment (`git grep -n "baskule:" apps/web`). Nothing is
deleted. New code only lives in `apps/web/src/baskule/`.

| Area                                       | Patch (file)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-run wizard never shown               | `routes/__root.tsx` (FirstRunGate `enabled=false`); `/welcome`, `/usage` and every settings page except `/settings/archived` redirect to `/` (`routes/welcome.tsx`, `usage.tsx`, `settings.tsx`)                                                                                                                                                                                                                                                                    |
| `/` = new chat                             | `routes/_chat.index.tsx` -> `baskule/BaskuleIndexLanding.tsx` (draft in the scratch project; shows progress, retries a failed start with backoff, "Try again", review M4). After the first send the URL moves from `/draft/<id>` to `/<env>/<thread>` (upstream promotion; it lands shortly after the message renders)                                                                                                                                            |
| New chat -> scratch ("No project") project | `baskule/useBaskuleNewChat.ts` (`openScratch` = server `ensureScratchProject`, then `useNewThreadHandler`); used by the sidebar button                                                                                                                                                                                                                                                                                                                            |
| Chat list                                  | `components/Sidebar.tsx`: slim rows, pinned chats first then the rest most-recent-first, drag to pin/unpin/reorder, Snoozed shelf; no favicon/PR/terminal/hover card; no Settled shelf when the space advertises no `threadSettlement` (`ServerEnvironment.ts`); status glyph (`baskule/BaskuleChatStatus.tsx`) and a `...` button opening the chat menu                                                                                                          |
| Chat menu = Rename / Archive / Delete      | `baskule/threadMenu.ts`, applied once inside `components/threadActionMenu.logic.ts` (`buildThreadActionMenuItems`), so the sidebar, header and every other caller get it                                                                                                                                                                                                                                                                                           |
| Sidebar header/footer                      | `sidebar/SidebarThreadHeader.tsx` is a 3-line wrapper rendering `baskule/BaskuleSidebarHeader.tsx` ("New chat" + "Search chats"); `sidebar/SidebarChrome.tsx` ("Baskule" text brand; footer = "Archived chats" + "Based on T3 Code (MIT)" link; no settings/PRs/usage/update pills); `AppSidebarLayout.tsx` keeps the chat list on `/settings/archived`                                                                                                          |
| Composer                                   | `chat/ChatComposer.tsx`: no model/provider/runtime-mode/plan controls (chats use the installation's one model); slash menu = the agent's configured commands and skills (`/plan` needs the hidden plan-mode setting); placeholder "Message Baskule"; provider-down copy "The assistant's computer is unavailable, retrying…" and a re-probe every 8 s while down (M3; `baskule/composer.ts`, `baskule/useProviderRetry.ts`); `chat/DraftHeroHeadline.tsx`: "What can I help with?" |
| Chat header                                | `chat/ChatHeader.tsx` (no project breadcrumb); `chat/PanelLayoutControls.tsx` (no terminal toggle); `chat/ThreadDetailsPanel.tsx`: the thread-details panel shows the chat's automations and forks/merge-back only (no machine/"Open in"/scripts/git); `ChatView.tsx` (right panel opens straight on Files); `RightPanelTabs.tsx` (action lists filtered to Files by `baskule/rightPanel.ts`); `ChatView.logic.ts` (draft title "New chat")                        |
| Files                                      | `files/useDirectoryEntries.ts` hides `.playwright-mcp`; `files/FilePreviewPanel.tsx`: **Download file** for every previewed file and a "can't be previewed — Download" body for binary files (`baskule/WorkspaceFileDownload.tsx`, signed `/api/assets` URL with `disposition: "attachment"`, see below); no empty "Open in" picker; on a phone the tree starts collapsed when a file is open                                                                      |
| Archived view                              | `settings/SettingsPanels.tsx` (group titled "Archived chats", no project icon), `settings/settingsLayout.tsx` (no scope sentence), `routes/settings.tsx` (header "Archived chats")                                                                                                                                                                                                                                                                                  |
| Keyboard / palette (M1)                    | `keybindings.ts` ignores bindings outside `baskule/keybindings.ts` (new chat, sidebar, right panel, thread details, find, stop, thread nav/jump, queue, stash): no terminal, diff, preview, palette, model picker, pin/settle, editors. `commandPaletteBus.ts`: the palette never opens (no "Add project")                                                                                                                                                         |
| "chat" copy                                | `baskule/copy.ts` rewrites thread→chat in confirm dialogs (`confirmDialog.ts`), toasts (`components/ui/toast.tsx`) and the sidebar/archived empty states                                                                                                                                                                                                                                                                                                           |
| Rebrand                                    | `branding.ts` (`APP_BASE_NAME` = Baskule, stage "Alpha"); static, not flag-driven: `index.html` (title, text splash instead of the T3 logo), `public/manifest.webmanifest`, `lib/bootError.ts`. `branding.test.ts` follows `APP_BASE_NAME`.                                                                                                                                                                                                                        |

Kept as upstream: streamed messages + tool-call timeline, user-input question forms, approvals, files panel /
preview / download, search, rename, phone drawer sidebar.

Verification (2026-10-22): `tsc-rs --noEmit` clean in `apps/web`; `vp test run --project unit` on Sidebar*, threadActionMenu,
ChatView.logic, ChatHeader, branding, `components/sidebar`, `components/files`, `hooks`, `routes`: 43 files / 774 tests pass.
Browser (`*.browser.test.tsx`) suites were not run.

Dev loop used: server `--base-dir baskule/.run/ui-<n>` with `GIT_CEILING_DIRECTORIES=baskule/.run` (otherwise the base dir
sits inside the umbrella git work tree and T3 refuses scratch projects, cf. D5), opencode provider pointed at a dead URL
(no LLM call; sends create the thread and fail), web rebuilt with `vp build` and copied into `apps/server/dist/client`.

Tests (review M6): the web vitest projects run with `VITE_BASKULE_UI=0` unless the variable is set (`apps/web/vite.config.ts`),
so upstream suites test upstream behavior; `src/baskule/*.test.ts` stub the flag on (`vi.stubEnv` + `vi.resetModules`).

Known gaps: provider error banners are upstream's; mobile strings still say "thread"
(≈180 strings, no seam); mobile has no file download.

## Context compaction (automatic only)

OpenCode 2 compacts on its own (`compaction.auto` defaults to on): before each model step it summarizes the
conversation once the context reaches the model's window minus max(15 %, 16k) tokens, and once more if the provider
rejects a request as too long; the turn then continues. The window is `BASKULE_LLM_CONTEXT_LIMIT`
(`platform/src/agent/config.ts`, default 200k): set it to the model's real window, or compaction only happens after a
rejection. The OpenCode 2 adapter maps `session.compaction.*` to a `compaction` turn item, which web and mobile draw
as a "Context compacted" divider in the turn (fixture `testkit/fixtures/opencode2_compaction`).

Compaction is automatic. There is no manual `/compact` action, provider compaction hook, or idle compaction worker.

## 0.2 web client (WP-E, branch `wp/e-web`)

Hosted multi-user build: `VITE_BASKULE_HOSTED=1` (with the 0.1 UI flags on).
Dev loop: `apps/web/baskule-dev/` (`./check.sh`).

| Area                                                | Patch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base path (upstreamable, root behaviour unchanged)  | `client-runtime/environment/endpoint.ts`: `environmentEndpointUrl` joins under the base path, `environmentSocketUrl` (`<base>/ws`), `resolveEnvironmentRelativeUrl` (server URLs under the base path unless already prefixed); used by `authorization/remote.ts`, `connection/resolver.ts`, `connection/presentation.ts` (`/mcp`), `rpc/http.ts` (API base keeps the path), `state/assets.ts` (`resolveAssetUrl`), `webhookAddress.ts`; `shared/remote.ts` and `shared/advertisedEndpoint.ts` keep a base path (a pairing link's directory is the backend); `onboarding.ts` bearer ids include a non-root path |
| Hosted mode                                         | `hostedPairing.ts` (`isHostedStaticApp` true); `connection/platform.ts` uses `baskule/spaces.ts` as the platform source: one `PrimaryConnectionRegistration` per space at `<origin>/s/<id>/` (same-origin cookie auth, no pairing), labels = space names, Personal first (= the app's primary environment), re-read on focus / every 60 s / after space changes                                                                                                                                                                                                                                               |
| Sign-in gate                                        | `routes/__root.tsx` → `baskule/root.tsx` (`GET /api/baskule/me`; 401 → `/login?next=`; bare `/login`, `/invite`, `/reset-password`); local storage cleared on sign-out and when another person signs in on the browser (`baskule/session.ts`)                                                                                                                                                                                                                                                                                                                                                               |
| New views                                           | routes `login`, `invite` (`#token=`), `reset-password`, `admin` (people + invitations, spaces, health), `apps` (desktop downloads; `/downloads/` is the front's file listing); `baskule/SpaceManagementDialog.tsx` (team space members/roles/rename/delete, new team space); `baskule/BaskuleUserMenu.tsx` in the sidebar footer (spaces you manage, admin, desktop app, change password, sign out); API client `baskule/api.ts` against WP-C's `/api/baskule`                                                                                                                                            |
| Authorship                                          | contracts `OrchestrationV2Author` (optional `author` on creation fields, as spike path-c); `session-logic.ts`, `types.ts`; `MessagesTimeline.tsx` names other people's messages (`baskule/authorship.ts`)                                                                                                                                                                                                                                                                                                                                                                                                     |
| Spaces in the UI                                    | `Sidebar.tsx` row label (`baskule/BaskuleSpaceLabel.tsx`, shown with 2+ spaces); the composer's "Run on" picker lists the spaces (upstream); connection banners say "Acme did not answer" (`baskule/copy.ts`, `ConnectionDiagnosisDetails.tsx`)                                                                                                                                                                                                                                                                                                                                                             |
| 0.1 hides lifted in hosted mode (thin-server scope) | chat menu: Pin, Snooze, Mark unread (`baskule/threadMenu.ts`); sidebar: pinned first, snoozed last, unread dot and weight (`Sidebar.tsx`, `BaskuleChatStatus.tsx`); `/settings/scheduled-tasks` + footer link (`baskule/settingsPages.ts`, `routes/settings.tsx`, `SidebarChrome.tsx`); shared Browser surface in the right panel (`baskule/rightPanel.ts`)                                                                                                                                                                                                                                                |
