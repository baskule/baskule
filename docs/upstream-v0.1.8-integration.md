# T3 Code v0.1.8 application integration

T3 Code published stable [v0.1.8](https://github.com/pingdotgg/t3code/releases/tag/v0.1.8)
on 9 November 2026. This integration advances Baskule from v0.1.6 by two stable releases.

The application starts from the complete released T3 Code tag `v0.1.8`, commit
`bf469bb19669671d0df2efda74ed73867a7137c0`. Baskule customizations were selected from
`a1c37528c020c96bfda99621563cd6c414d6c371`, including the mobile UX and native connection
changes in #70. The comparison base for identifying those customizations was T3 Code
`v0.1.6`, commit `2359643cffa6ba9ee84d6f2694b935de54a8013e`.

The reconstruction materialized the full released upstream tree before reapplying the
Baskule overlay and removing excluded execution surfaces. It does not apply a selected
list of upstream pull requests to the previous fork. Upstream licenses and notices remain
in the application, and [source provenance](../source-provenance.json) names the released tag.
The tag itself reports package version 0.1.7; provenance identifies the release independently
of that package metadata.

## Decisions by area

| Area | Result and reason |
| --- | --- |
| Contracts and orchestration | Use released upstream contracts, V2 projections, batching, thread paging, run recovery, scheduling and managed-policy APIs. Retain Baskule authorship and authorization at RPC boundaries. Keep historical decoders and migration bodies needed by supported installations. |
| Hosted runtime | Adapt workerd layers to Effect 4.1.2, the new SQL client driver contract, filesystem operations and service dependencies. Keep one shared SQL client, multiplexed alarms and the same-cell native I/O request. Publish orchestration events outside SQL transactions. Trim the host-machine policy loader so nested upstream layers use the cell policy boundary consistently. |
| Providers | OpenCode 2 remains the only executable agent driver. Retain generic instance contracts and retired-provider data decoding. Remove additional providers, provider installation commands and excluded direct-provider text generation. |
| OpenCode | App client/protocol/schema and platform runtime packages use 2.1.3. This advances the previous app SDK 2.1.2 and keeps the existing platform runtime 2.1.3; upstream's 2.0.28 pin is not imported. Remove the obsolete 2.0 compaction response shim. Decode supported history directly with the matching SDK. |
| Authentication, teams and spaces | Retain Baskule login, teams, space membership, authorship, per-space computers, plugin connections and server-held credentials. Preserve hosted path and WebSocket identity routing. New desktop administration and excluded product RPCs remain outside SpaceCell's allowed surface. Export newly generated signing keys directly to PEM; avoid the new JWK re-import that rejects workerd's alternate Ed25519 PKCS#8 encoding. Existing key records are preserved. |
| Scheduling | Adopt released thread-mode and interval/one-shot behavior while retaining actor checks. Owners with stop-others permission receive redacted task data after changing another author's task, including the enabled-state update path. |
| Voice | Use released dictation controller, composer UI and browser PCM capture. Encode browser PCM as a WAV Blob for the existing `/api/baskule/transcriptions` route. Native recording uses its supported recorder and the same hosted route. Remove superseded local voice controls and native model settings. Web dictation cancels on chat/account changes and discards late results. Sending during web recording finishes transcription, commits the text and sends once. Native dictation retains its existing off-screen recording behavior and requires a separate Send tap. |
| Transcription boundary | Keep ControlCell's bounded 25 MiB upload, upload and provider timeouts, per-user/global concurrency, server-held credentials and redirect refusal. No new service or client-side provider key is introduced. |
| Tool visibility and Labs | Default the shared `ClientSettingsSchema` to `hideAll`. Missing legacy settings and reset use that default; explicit `showAll`, `hideSuccessful`, `hideAll` and `zen` survive persistence/reload. Main and side-chat fallback behavior agrees. Approval/question handling and errors remain available. Use upstream Labs cleanup and remove excluded linked-environment options. |
| Localization | The released tag has marketing localization but no shared application catalog. Keep Baskule's shared localization module, web/mobile adapters and en/de/es/fr/it/nl catalogs, and translate newly retained strings. Keep translation CI coverage; no unreleased i18n proposal is imported. |
| Mobile and desktop | Adapt current Baskule connection/account paths to released upstream APIs. Preserve #70 protected image/PDF preview lifetime, private image caching, authenticated sharing and native navigation behavior. Retain Baskule release compatibility and update feeds. Use the released desktop identity implementation instead of the superseded WM-class field. |
| Exclusions | Remove forge PR execution/workflows, linked environments and peer delegation, external secret-provider execution, additional agent drivers, marketing app, T3 commercial account entry points and fleet switching. Retain harmless historical data contracts where required; do not restore retired tables just to match upstream's migration list. |
| Contributor checks | Follow upstream's `effect-tsgo tsrs --noEmit` runner in repository check scripts and the desktop regression script. Frozen application and platform lockfiles remain separate. |

## Migration boundary

The runtime manifest preserves Baskule's deliberate omissions of migration 065 and
peer-only 070–072. Historical supported migration bodies through 076 are unchanged.
New migrations run forward:

- 077 normalizes `settledOverride`.
- 078 drops the obsolete correlation index.
- 079 adds recovery indexes over existing V2 projections.
- 080 adds and backfills scheduled-task `thread_mode`.

No migration is empty, falsely marked as applied, or used to reset the schema. The
released compatibility window remains version 0.5.2 with minimum client/server 0.5.1.

`BaskuleUpgrade.test.ts` uses a frozen manifest from the actual Baskule main history,
not a truncated new manifest. A separate test-only upstream-076 fixture includes the
real retired migrations and their layouts; those files do not enter the runtime
manifest. Tests cover fresh databases, both historical manifests, repeated startup,
rejection of missing or conflicting required V2 history, auth/chat/authorship preservation and
bound/unbound scheduled-task backfills.

## Verification

Temporary command output belongs under `.run/evidence/upstream-v0.1.8/` in the integration
worktree. The `implementation/` directory preserves the initial reconstruction checks. Focused evidence covers contracts and settings persistence, migration histories,
auth/secrets and task authorship, project pagination, hosted transcription, browser voice
cancellation/send races, native protected previews, shared SQL and native I/O ownership.
The bundled OpenCode adapter is exercised in workerd with the fake provider, including
plain chat without a computer, browser/computer tool registration, cancellation and SDK
stream cleanup; checking package versions alone is insufficient.

A disposable installation seeded on current main was restarted with the upgraded runtime.
Authentication, conversation content, authorship, and both scheduled-task backfill branches
passed through the hosted APIs. Independent review and client verification track additional
findings separately; the PR records their final status and any native-platform limits.
Nothing in these local checks authorizes deployment or changes to an installation.
