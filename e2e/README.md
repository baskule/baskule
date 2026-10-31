# e2e — Baskule end-to-end feedback loops (WP-H)

The deployed checks run against the **real stack** (`deploy`, `http://127.0.0.1:47090`), signed in, with
system Chrome. No LLM spend by default. These loops own the seams only the deployed stack has (edge, two-node fleet,
real computers, the browser UI on real cells); lower loops prove the rest. **Which loop to run for a change:
[development workflow](../docs/development-workflow.md)**. These checks change deployment state: run them only when
the owner asks, and then one area (`scripts/check e2e:<tag>`), not the whole suite.

| Loop | Command | Time |
|---|---|---|
| One area | `scripts/check e2e:chat` (= `e2e/run.sh --grep @chat`) | 0.5–3 min |
| One spec | `e2e/run.sh tests/05-security.spec.ts` (any spec runs alone) | 0.5–2 min |
| Parallel phase only | `scripts/check e2e` (= `E2E_SLOW=0 e2e/run.sh`) | see the workflow doc |
| Acceptance (both phases) | `e2e/run.sh` | see the workflow doc |
| Infrastructure smoke (WP-A) | `scripts/check infra` (= `e2e/infra-smoke.sh --no-up`) | 2–4 min |
| Real model | `E2E_REAL=1 e2e/run.sh --grep @real` | ≈ 1 min, ≈ $0.002 |
| Build + deploy + suite | `BUILD=1 [T3_APP_DIR=…] e2e/run.sh` | + build |
| Performance samples | `e2e/run.sh --project perf` (17c), `e2e/perf/run.sh <label> 5` | minutes |
| UX journeys (for the reviewer) | `e2e/ux/run.sh [journey…]`, then a reviewer agent with `ux/BRIEF.md` | ≈ 5 min |

`run.sh` takes the stack lock (`deploy/.stack-lock`), changes the organization AI endpoint to the LLM router through the admin API and shortens the idle policy (`E2E_IDLE_MINUTES`, default 1.5), runs Playwright in two
phases — `main` (every independent spec, `E2E_WORKERS` parallel slots, default 2) then `lifecycle` (`@slow`, one at
a time, after `main`; `E2E_SLOW=0` skips it) — logs real-model spend to `.run/llm-spend.md`, then
restores the saved organization AI and idle settings ( `KEEP_ROUTER=1` keeps the router between the runs of an iteration
session; `RESTORE=0` restores nothing). Any Playwright selection (files, `--grep`) applies to both phases; `--project
<name>` runs one project only. The suite tests the **deployed** build: a test-only change needs no redeploy.
Artifacts: `e2e/artifacts/` (screenshots per scenario, `metrics.jsonl`, `results-main.json`,
`results-lifecycle.json`, `05-security/checks.json`, traces of failures, `world*.json`).

The shared Playwright dependencies live in `package.json`. Worktree application journeys live in
[`journeys/`](journeys/README.md).

## LLM router (`llm/`)

Real-model runs require `E2E_REAL_API_KEY` supplied privately with a Mistral key; fake runs need no provider key.
The router connection uses `custom/<model ID>` and has its own credential slot, leaving the normal provider key
untouched when settings are restored.

`llm/router.mjs` runs as container `baskule-e2e-llm` on `baskule-net` (`llm/llm.sh router|restore|usage|status`):
- every chat completion goes to WP-C's fake LLM (`platform/dev/fake-llm`, markers `[[fake:text …]]`,
  `[[fake:tool <name> <json>]]`, `[[fake:long N]]`, `[[fake:delay ms]]`, `[[fake:describe]]`);
- a request whose last user message contains **`[[real]]`** goes to Mistral (mistral-large-4) with the caller's key (the
  embedded agent's, from ControlCell), the marker stripped; usage is metered per request; a budget (default $0.25 per
  router volume) answers 429 beyond it;
- T3's chat-title prompts always get a fake title (no tool runs twice, no spend).

OpenCode's tool names for fake tool calls: `shell {command}`, `read`, `glob`, `grep`, `patch`, `question`,
`*preview_open {url}`, … (the `*` resolves the dynamic T3 MCP prefix) The exact tool set depends on the thread’s registered MCP servers and enabled skills; inspect the captured
request’s `tools` list rather than assuming a fixed count.

Chat and conversation lifecycle now run on the worktree stack: `scripts/check feature:personal-chat`, `feature:team-chat`, and `feature:conversation-controls`.

## Scenarios (`tests/`)

Every spec is independent: it uses the API-created fixture world of its worker slot (`lib.ts` `world()`: Alice, Bob,
team space Acme; slot 0 keeps `world.json`), or its own people (01, 10b). Specs that change memberships (06, 15)
restore them. Tags select areas (`--grep @files`); `@slow` specs form the serial `lifecycle` phase.

| File | Tags | Scope item |
|---|---|---|
| `01-admin-onboarding` | `@auth @admin` | (a) admin bootstrap sign-in, Alice with a temporary password, Bob by invitation (single use), team space Acme with both (its own people) |
| `03-tool-files` | `@files @computer`, `@browser` | (c) a shell task starts the computer; output file in the files panel, download byte-identical; the agent's browser reads example.com |
| `04-team-live-queue` | `@chat @team` | (d) Bob watches Alice's run stream live with her name; his message during the run is queued (visible to both) and answered next |
| `05-security` | `@security @auth` | (e) 52 checks through the deployed edge: other personal space (HTTP, WS, API, UI), admin cannot read personal spaces, no enumeration, forged identity headers, unsigned bearer, cross-origin WS/POST/sign-in, `Origin: null`, internal `_baskule` routes in 5 encodings, path and static traversal, closed Better Auth admin/sign-up routes, member vs admin actions, RPC confinement (T3 home, `..`, other space's chats, terminal, settings writes), no secrets in the server config. It creates its own positive-control chat when Alice has none |
| `06-member-removal` | `@security @team` | (f) admin removes Bob: his socket closes (< 5 s) and Acme leaves his open tab (< 15 s); Bob re-added |
| `07-idle-wake` | `@lifecycle @slow @computer` | (g) idle computer stops (computerd idle stop lowered to `E2E_IDLE_WAKE_MINUTES`, 0.5, for this test); the next task wakes it; files kept |
| `08-restart` | `@lifecycle @slow` | (h) `down.sh` + `up.sh`: sessions, accounts, chats, files kept |
| `09-failover` | `@lifecycle @slow` | (i) kill each celld node in turn between turns: the chat continues |
| `10-uploads` | `@files @chat` (`@computer`) | (j) image/PDF → native model parts without a computer; CSV → on the computer |
| `12-phone` | `@ui @phone` | (l) phone viewport: sign-in, drawer, chat, files, admin; no horizontal overflow |
| `13-real-model` | `@real` | mistral-large-4: plain answer and actual PDF text with no computer; shell task file checked on the computer (`E2E_REAL=1`) |
| `14-file-search` | `@files` | filename and content search through the authenticated computer boundary; whole-word ranges, invalid-regex fallback, forbidden root rejected |
| `15-shared-browser` | `@browser @team @security` | two viewers hand off browser control; human ownership blocks agent navigation; membership revocation closes the viewer stream |
| `16-admin-health` | `@admin @computer` | start a real computer, compare its phase with admin status and the displayed running-computer count |
| `17-agent-core` | `@lifecycle @slow` (a), `@chat @computer` (b), `@perf` (c) | (a) the same chat keeps its tools across a rolling celld restart — the regression the merged suite found, keep it unweakened; (b) plain chat and its deletion never start a computer; (c) cold/warm timings (on request) |
| `18-direct-provider` | `@real` | the configured real provider: greeting without a computer, then DOCX/PDF in the same chat (`E2E_DIRECT_REAL=1`) |

**Stability rules.** No blanket retries. Known host artifacts only: one reload on `net::ERR_NETWORK_CHANGED` (Chrome on
the Docker host), and waiting out the front's sign-in rate limit (10/min per address; the suite reuses sessions by
cookie, `tests/lib.ts` `personApi`/`signInBrowser`). Timeouts allow for a loaded host.

## UX loop (`ux/`)

`ux/journeys.mjs` drives six journeys (admin onboarding, member first chat, team collaboration, file round-trip,
schedule setup, phone layout) and saves per step a screenshot and the visible text + accessibility snapshot in
`artifacts/ux/<journey>/`. A reviewer sub-agent follows `ux/BRIEF.md` and writes `ux-findings.md` (severity
high/medium/low). Fix high/medium findings in the active task branch, then rerun the affected journeys.

Partial runs reuse fixtures only when `E2E_RUN` matches the saved world. `E2E_WORLD_FILE=/absolute/path.json`
keeps a separate fixture world for independent acceptance runs (slots > 0 add `-w<n>`); the default remains
`artifacts/world.json`. A zero-directory security control is a failed setup, not a security pass. The space picker uses the accessible
`combobox` named `Run on`, with `option` items. File attachments are inline editor tokens: fill the message before
attaching, or type without replacing the editor contents afterward.


## Release gates

`17-agent-core` (a) checks the same chat's tools before and after restarting both nodes and (b) plain-chat deletion
without a computer wake; (c) records cold/warm timings (`--project perf`). `perf/run.sh <label> 5` records repeated
sign-in timings and node memory; compare host load and cell counts alongside medians.

`18-direct-provider` checks a greeting followed by DOCX/PDF creation in the same chat against the configured real provider. Restore the normal endpoint with `llm/llm.sh restore`, hold the stack lock, and invoke Playwright directly with `E2E_DIRECT_REAL=1` and a fresh `E2E_RUN`/`E2E_WORLD_FILE` (do not use `run.sh`, which enables the fake router). Supply the admin password privately through `E2E_ADMIN_PASSWORD`. The test rejects an active `.run/e2e-product-settings.json` settings backup, verifies no computer for the greeting, then validates the actual DOCX ZIP/XML and PDF signature produced by the model. Remove only the fixture accounts/spaces afterward.
