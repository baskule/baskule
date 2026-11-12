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
| OpenCode | Pin app client/protocol/schema and platform core/schema/sdk/util together to exactly 2.2.5. The released adapter gates native goals on that runtime; importing upstream's npm 2.0.28 pin would downgrade Baskule and disable them. Keep upstream's separate `@opencode-ai/sdk` dependency. |
| Runtime adaptation | Process completed Code Mode host calls before queued polling jobs, preventing polling starvation in workerd. Guard the transform against dependency-layout changes. Native cancellation, scheduler and stream-cleanup checks exercise the production transforms. Refresh native goal state after pause/clear so a delayed notification cannot leave stale UI state. |
| Authentication, teams and spaces | Preserve platform login, team/space membership, authorship, server-held credentials, plugin connections, per-space computers and authenticated asset routing. OpenCode 2 remains the only executable agent driver. |
| Goals | Use upstream native goal commands and version-gated capabilities. Keep commands separate from steering, prioritize queued goal controls and defer context delivery until a prompt turn. Remove clauses specific to excluded drivers. |
| Voice | Reuse upstream dictation controls and lifecycle, with browser/native transcription routed through `/api/baskule/transcriptions`. Keep hosted credential and upload limits. Remove orphan destination/model controls that would call unavailable local or T3 services. Preserve the existing hosted voice implementation where upstream's new service choices cannot replace it. |
| Tool visibility and accessibility | Preserve `hideAll` for fresh settings and explicit saved choices from Baskule 0.5.3. Adopt upstream screen-reader announcement settings and localize the retained labels and announcements. |
| Localization | Upstream supplies no application translation catalog. Preserve shared localization and en/de/es/fr/it/nl catalogs; extract and validate newly retained strings. No translation API key or paid translation call is used locally. |
| Mobile and desktop | Adapt existing Baskule connection/navigation and protected-preview behavior to upstream APIs. Adopt file-link context, scrolling, downloads and desktop release metadata. Preserve required-update handling and hosted attachment authentication. |
| Exclusions | Remove newly introduced extra-provider tests, forge PR helpers/workflows, linked-environment behavior, T3 agent approval/account surfaces, unsupported cloud voice controls and the standalone upstream scenario runner. Baskule's disposable fake-model journeys remain the verification path. Keep required historical data decoders. |
| Third-party notices | Regenerate locks from reviewed manifests and synchronize notices, including OpenCode's separate legacy SDK and Nodable's newly resolved entities version. |

The UI placement decision for review is to show upstream's announcement row beside tool
visibility in Personal settings → Chats. Its control and wording reuse upstream's design.
Also review background-work labels, native file-link context and navigation width/selection
API adaptations; the existing Baskule UI and upstream interaction designs are retained.

## Migration boundary

Adopt **081 ProjectionMessageSearchText** as a forward migration over the shipped V2 tables.
It adds readable search text, replaces search-index triggers and backfills citation content
in pages. Applied identifiers and the deliberate omissions 065 and 070–072 remain unchanged.
No schema reset, empty placeholder or retired runtime table is introduced.

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
| `scripts/check space` | All 17 passed with the real 2.2.5 workerd bundle and fake provider. |
| Mobile attachment/voice selection; asset-cache React selection | 45 and six tests passed respectively; other previously passing mobile selections retained. |
| Desktop source regression suite and corrected update selection | Unchanged files passed; corrected update file passed all 41 tests. Packaged application not exercised. |
| Hosted transcription/API/settings unit selection; browser PCM/hosted dictation | 20 unit tests, four voice browser tests and four live-region browser tests passed. |
| `scripts/stack doctor`; `scripts/check journey:personal-chat` | Doctor passed; all four desktop/phone journeys passed; stack stopped and evidence retained. |
| Retired/new upstream path audit | No reintroduced excluded paths. |
| Full `scripts/check upstream` server | 4,531 passed, four failed, six skipped. The three failed files passed focused reruns: 203 tests plus seven permission tests with DAC bypass dropped. |
| Full `scripts/check upstream` web | 4,529 passed, five failed. Both failed files passed all 123 tests after adapting explicit visibility and branding expectations; live-region browser tests also passed four cases. |

Failures were classified before retry: dependency-install concurrency, unavailable Docker
bridge networking, root bypass of chmod-based permission fixtures, and the optional HTTPS
proxy were environment failures; SQL statement
splitting, removed-provider, visibility-default and branding assumptions, missing test-session state and concurrent Vitest
cache cleanup were harness failures. A later SpaceCell selection invocation completed all
17 runner checks, then the wrapper rejected the unsupported `--only` flag; the supported
`space:native-goals` entry point was used for the focused confirmation. The theme permission
file passed all seven tests with DAC-bypass capabilities dropped for that process, preserving
its assertions. Code Mode starvation, stale goal projections and
missing desktop release metadata were product failures fixed and verified in their affected
selections. Merge/type/lint errors were corrected before the final checks. Verbatim upstream
generated highlighting C and dependency patch context retain their existing whitespace;
hand-edited application changes pass the diff whitespace check with those files excluded.
