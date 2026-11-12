# T3 Code v0.1.9 application integration

T3 Code published stable [v0.1.9](https://github.com/pingdotgg/t3code/releases/tag/v0.1.9)
on 11 November 2026. Baskule was one stable release behind, at v0.1.8. This integration
adopts native OpenCode goals, todo and background-work tracking, accessibility announcements,
faster long-thread and MCP reads, attachment sending, and image/PDF/file-link fixes.

The reconstruction starts from the complete released tag, commit
`24e77473ecf41bc1f7142529c7911c1c1aae1d76`, with the reviewed Baskule overlay from
`9505bf259076024b5d7d01d7bba5882aa0c72ced`. The overlay comparison base is upstream
v0.1.8, `bf469bb19669671d0df2efda74ed73867a7137c0`. Release API metadata and the tag
were verified independently. The released-gap analysis covers the complete paginated
comparison; no nightly or post-tag changes are included.

The complete upstream tree was materialized under `.run/` before reapplying the overlay.
Inventories include added, removed, modified and executable paths, outside-app contract
boundaries, newly added upstream paths and conflict decisions. Upstream attribution and
licenses remain; [source provenance](../source-provenance.json) records the release.
The released desktop manifest still says 0.1.8; the verified tag identifies the upstream
release independently of that package metadata.

## Decisions by area

| Area | Result and reason |
| --- | --- |
| Contracts and orchestration | Adopt released projections, bounded MCP/long-thread reads, attachment and background-work behavior. Retain Baskule actor authorization and authorship. Task-owner checks load the required messages separately from upstream's smaller caller projection. |
| Hosted runtime | Keep one shared SQL client per SpaceCell, multiplexed alarms and same-cell native I/O. Adapt native Effect continuations to 4.0.6 for the matching OpenCode runtime. Do not introduce another cell, service or alarm. |
| OpenCode | Pin app client/protocol/schema and platform core/schema/sdk/util together to exactly 2.2.5. The released adapter gates native goals on that runtime; importing upstream's npm 2.0.28 pin would downgrade Baskule and disable them. Remove the unused OpenCode 1 `@opencode-ai/sdk` dependency. |
| Runtime adaptation | Process completed Code Mode host calls before queued polling jobs, preventing polling starvation in workerd. Guard the transform against dependency-layout changes. Native cancellation, scheduler and stream-cleanup checks exercise the production transforms. Refresh native goal state after pause/clear so a delayed notification cannot leave stale UI state. |
| Authentication, teams and spaces | Preserve platform login, team/space membership, authorship, server-held credentials, plugin connections, per-space computers and authenticated asset routing. OpenCode 2 remains the only executable agent driver. |
| Goals | Use upstream native goal commands and version-gated capabilities. Keep commands separate from steering, prioritize queued goal controls and defer context delivery until a prompt turn. Remove clauses specific to excluded drivers. |
| Voice | Reuse upstream dictation controls and lifecycle, with browser/native transcription routed through `/api/baskule/transcriptions`. Keep hosted credential and upload limits. Keep upstream's local-model, cloud-provider and destination paths in the web tree, gated off in hosted builds, so later upgrades merge cleanly. Hosted builds record from the browser default microphone and show no voice settings route, search result, setup dialog or settings action. Delete the mobile on-device transcription module and destination code; mobile keeps its microphone settings for the native recorder. |
| Tool visibility and accessibility | Preserve `hideAll` for fresh settings and explicit saved choices from Baskule 0.5.3. Adopt upstream screen-reader announcement settings and localize the retained labels and announcements. |
| Localization | Upstream supplies no application translation catalog. Preserve shared localization and en/de/es/fr/it/nl catalogs; extract and validate newly retained strings. No translation API key or paid translation call is used locally. |
| Mobile and desktop | Adapt existing Baskule connection/navigation and protected-preview behavior to upstream APIs. Adopt file-link context, scrolling, downloads and desktop release metadata. Preserve required-update handling and hosted attachment authentication. |
| Exclusions | Remove newly introduced extra-provider tests, forge PR helpers/workflows, linked-environment behavior, T3 agent approval/account surfaces, unsupported cloud voice controls and the standalone upstream scenario runner. Baskule's disposable fake-model journeys remain the verification path. Keep required historical data decoders. |
| Third-party notices | Regenerate locks from reviewed manifests and synchronize notices, including Nodable's newly resolved entities version; remove the unused OpenCode 1 SDK. |

The UI placement decision for review is to show upstream's announcement row beside tool
visibility in Personal settings → Chats. Its control and wording reuse upstream's design.
Also review background-work labels, native file-link context and navigation width/selection
API adaptations; the existing Baskule UI and upstream interaction designs are retained.

## Migration boundary

Adopt **081 ProjectionMessageSearchText** as a forward migration over the shipped V2 tables.
It adds readable search text, replaces search-index triggers and backfills citation content
in pages. Applied identifiers and the deliberate omissions 065 and 070–072 remain unchanged.
No schema reset, empty placeholder or retired runtime table is introduced.

Embedded OpenCode advances from 2.1.3 to 2.2.5 and applies nine additional migrations
on the same SpaceCell SQLite client. A disposable `origin/main` space supplied real
fake-model history, authorship and a persisted `job.background/%` row. Celld applied
all nine migrations under its SQL authorizer (50 → 59 recorded migrations), consumed
the legacy job row, preserved the messages and authors, and answered a new fake-model
message in the existing thread. No installation or released data was touched.
The managed runtime probe reports 2.2.5 so native-goal capability discovery matches
the embedded version before the first turn.

`BaskuleUpgrade.test.ts` freezes the actual Baskule main manifest through 080, alongside
existing Baskule/upstream 076 fixtures. Both Node SQLite and the hosted SQL adapter prove
fresh startup, forward upgrade, repeated startup, required-history rejection, preserved
authentication/authorship/schedules/messages and correct citation search backfill across
the 500-row page boundary. Plain text stays intact and encoded citation metadata is not
indexed. The hosted test adapter now splits SQL without treating literal or trigger-body
semicolons as statement boundaries.

The compatibility manifest stays at source version **0.5.3**, minimum client/server **0.5.2**.
New announcement preferences are client settings; goals use existing optional wire contracts
and advertised capabilities; migration 081 is internal to server search. The integration adds
no mandatory RPC or required client field that warrants raising the minimum. A normal future
backend startup applies 081 forward; no data wipe or manual deployment step is needed.
This change does not publish a release, deploy, restart or change an installation.

## Verification

Command output and reconstruction records belong under
`.run/evidence/upstream-v0.1.9/` in the integration worktree. The pull request records the
final command outcomes and any remaining limits. Evidence covers frozen installs, web and
SpaceCell builds, affected typechecks/lint, localization, settings persistence, migration
histories, adapter replay, native continuations and the complete SpaceCell suite.

The actual OpenCode 2.2.5 bundle is exercised in workerd with a fake provider: plain chat,
computer/browser tool registration, cancellation, pending-stream disposal and native goal
capability plus set/clear round trips. Package version checks alone are not the proof.
Disposable hosted browser journeys cover streaming chat and reconnect/refresh on desktop
and phone layouts. Native Android/iOS and packaged desktop acceptance require their own
available device/build environments and are reported separately from browser checks.
Independent review remains required before merge. No real-model or performance samples
are part of this verification.

| Check | Outcome |
| --- | --- |
| `scripts/worktree setup`; `scripts/check plan` | Passed; initial and final changed-surface plans recorded. |
| Release API, tag resolution and final `git fetch origin main` | Stable release and exact commit verified; starting main remains `9505bf259`. |
| Both `pnpm install --frozen-lockfile` workspaces; `pnpm run licenses:sync` | Passed after regenerating reviewed locks and resolving notices. Early commit snapshots also passed both frozen offline installs and hosted web builds. |
| `scripts/worktree runtime`; `pnpm --filter baskule-platform build`; `deploy/build.sh --no-deploy`; final web `vp build` | Passed. Production bundles and local images built; nothing deployed. |
| Affected package typechecks; direct server, web, mobile, desktop and platform typechecks | Passed after adaptation; Effect diagnostic suggestions remain non-blocking. |
| Changed application `vp lint`; `node scripts/lint.mjs` | Passed; four warnings in released markdown plugins. |
| `localization.ts extract`; `localization.ts check` | All 6,929 messages validated in each retained locale, without a translation key. |
| Settings contract tests and frozen-main 0.5.3 settings probe | 89 tests passed; fresh defaults and five saved profiles round-tripped across all three announcement choices. |
| `BaskuleUpgrade.test.ts`, hosted SQL tests and migration 081 tests | Passed; both SQL paths, frozen 080, repeated startup, preserved records and paginated FTS backfill. |
| OpenCode driver, adapter and provider/orchestration selections | Driver 24 passed; native-goal replay 21 passed; corrected server selection 203 passed. |
| Native Effect/Code Mode and embedded-build tests | Six passed, including busy polling, cancellation and retained callback ownership. |
| Review goal/restart/native-child Stop selections; driver/version probes | 89 restored orchestration cases, three missing/false/true native-goal capability cases and 35 provider cases passed. |
| Cookie-only OAuth and frozen 080 migration selection | 19 passed across OAuth, Node SQLite and the hosted SQL adapter. |
| `scripts/check space:native-goals` with compatible celld | Passed: real workerd 2.2.5 capability, set and clear through native RPC/events. |
| Existing SpaceCell OpenCode 2.1.3 → 2.2.5 | Nine migrations applied (50 → 59), legacy background row consumed, history/authorship preserved and a new fake-model continuation passed. |
| `scripts/check space` | All 17 passed with the real 2.2.5 workerd bundle and fake provider. |
| Mobile attachment/voice selection; asset-cache React selection | 45 and six tests passed respectively; other previously passing mobile selections retained. |
| Desktop source regression suite and corrected update selection | Unchanged files passed; corrected update file passed all 41 tests. Packaged application not exercised. |
| Hosted transcription/API/settings unit selection; browser PCM/hosted dictation | 20 unit tests, four voice browser tests and four live-region browser tests passed. |
| Voice restore: focused web/desktop/client-runtime/contracts/mobile selections; hosted dictation journey | 112 web speech/citation/preview, 268 desktop preview, 48 client-runtime voice, one contracts IPC and 48 mobile voice tests passed, including upstream's speech hook suite under `VITE_BASKULE_UI=0` and the ten hosted mobile adapter cases. A fake-model stack recorded from the default microphone despite a stale saved device id, inserted the transcript, cancelled without upload, kept the draft on a route error and retried; all voice traffic used `/api/baskule/transcriptions`, and settings, deep links and first run showed no voice setup. |
| PR CI after review fixes | Compatibility guard, harness, root/web/mobile/shared typechecks, desktop check, platform/server/web/shared/mobile tests and required gate all passed. |
| `scripts/stack doctor`; `scripts/check journey:personal-chat` | Doctor passed; all four desktop/phone journeys passed; stack stopped and evidence retained. |
| Retired/new upstream path audit | No reintroduced excluded paths. |
| Full `scripts/check upstream` server | 4,553 passed in 382 files; six existing cases skipped. Root permission fixtures ran with DAC bypass dropped. |
| Full `scripts/check upstream` web | 4,523 passed in 329 files after the voice-worker integration; earlier transport run passed 4,534 in 330 files. |

Failures were classified before retry. Root permission fixtures run with DAC bypass
capabilities dropped, preserving their assertions. The earlier queued-goal-pause failure
was a stale Claude rejection expectation. The OpenCode case now keeps a queued pause
on the picked instance with native goals and refuses steering a goal command into a
pre-2.2.5 instance without adding events. It does not assert that older runtimes reject
queued goal commands.
The upgrade check corrected an intermediate bundle and preserved a stable fake-model
endpoint across stack restarts. Driver-probe coverage now explicitly refreshes a cached
success before testing rejection and recovery. Docker bridge failures used the matching
prebuilt celld binary. Detailed logs and failure classifications stay under
`.run/evidence/upstream-v0.1.9/`. No real-model or performance check was run.

## Review corrections

Contract changes are additive optional/defaulted fields, wider accepted inputs, and internal
search changes. Minimum client/server versions stay at 0.5.2; the `compatibility-noop` label
records that reviewed decision. MCP approval accepts browser sessions only; bearer/DPoP
approval for the excluded T3 Connect service is removed.

Restore native goal dispatch, queue promotion, restart, deferred side-chat context and
native-child Stop tests with OpenCode fixtures. Sibling completion-wake cases use local
child tasks and Baskule authorship. Only `promoting %s into a compaction stops it and sends
it next` (three cases) remains excluded: the OpenCode adapter has no `compactThread` and
Baskule removed native compaction. Goal commands defer context until a prompt turn, and
pending context now survives a completed goal turn. Native child Stop uses the existing
OpenCode interrupt/confirmed-outcome path. The frozen 080 fixture uses the released
`AFTER UPDATE OF payload_json, streaming, role` trigger, independently of migration 081.
