# T3 Code v0.1.10 integration

T3 Code published stable [v0.1.10](https://github.com/pingdotgg/t3code/releases/tag/v0.1.10)
on 17 November 2026. This updates Baskule from v0.1.9, one stable release behind.
The release API confirms `draft=false` and `prerelease=false`; the tag resolves to
`7d32075e3757ded707914e2450c3e392a9665765`.

The application starts from that complete released tree. The retained Baskule layer comes
from main at `722bbd85b050d1d59cac66f82e61692fee42e51c`, compared against upstream v0.1.9
at `24e77473ecf41bc1f7142529c7911c1c1aae1d76`. Release research covers all 1,924 commits
in the paginated comparison. No later main changes, nightlies or open upstream PRs are included.

## Product decisions

| Area | Integration and reason |
| --- | --- |
| OpenCode | Adopt released adapter recovery, native resume, background-work and MCP fixes. Keep matching app and embedded OpenCode 2.2.5 packages. The tag's older dependency pin would downgrade Baskule; its 2.2.6 capability guards do not require upgrading the runtime. |
| Hosted platform | Preserve authentication, space membership, authorship, plugins and per-space computers at their existing boundaries. Keep one shared SpaceCell SQL client, same-cell native requests and multiplexed alarms. |
| Voice | Reuse upstream capture, controls and transcript insertion. Browser and native recordings use the authenticated platform transcription endpoint. Remove superseded draft-revision tracking; retain account-change cancellation, upload limits and private credentials. Hosted users see only supported controls. |
| Tools and accessibility | Default missing preferences to `hideAll`; preserve every explicit saved value. Retain upstream reveal behavior and independent screen-reader preferences. |
| Translations | Reuse released Settings translations where they match retained messages. Keep one i18next runtime, six complete locale catalogs and existing device language preferences. The tag's GT implementation covers Settings only, so it does not replace Baskule's full-app translation system or its Italian and Dutch support. Future translation proposals are outside this integration. |
| Clients | Adopt desktop lifecycle/audio recovery and mobile rendering, attachment, navigation and schedule improvements. Keep authenticated assets, account flows and installation-compatible desktop updates. |
| Product scope | Disable unsupported provider, Connect, commercial and developer-forge entrypoints after importing the complete release. Preserve required historical decoders. Existing side chats remain; expanding them is not part of this upgrade. |

The small translation adaptation converts the released GT call sites to the existing translator
and removes the unused GT runtime and configuration. Existing reviewed translations take
precedence on collisions. One device preference continues to support automatic language
selection; an upstream default of English must not replace a saved Baskule preference.

## Persistence and runtime boundaries

Keep all fifteen new application migrations, 082–096, including shared authentication tables.
Historical omissions 065 and 070–072 stay absent; no applied identifier is reused or replaced
with an empty migration. Upstream's missing-history preflight reads the Baskule manifest.
Each migration completes transactionally and later startup resumes unfinished work.
Released data must upgrade forward without a reset.

Historical migration 026 can leave model options as a JSON string containing an array,
depending on SQLite's JSON handling. The options decoder accepts that saved representation
and continues to encode arrays. Existing rows stay untouched; this reader compatibility
needs no new migration identifier and remains necessary while those histories are supported.

The client/server boundary stays at `0.5.4`. The server retains the full `thread.visited`
event accepted by released clients; other contract additions are optional or capability-gated.
The compatibility guard therefore uses `compatibility-noop`. Operators should follow the existing
backup procedure before upgrading. Downgrading a migrated database to an 081 build is not verified.

The application uses the target's Effect 4.1.3 and Node 26.13.1 pins. Embedded OpenCode keeps
its separate matching Effect 4.0.6 dependency graph. Hosted composition, native continuations
and HTTP-codec transformations remain guarded against the exact source they rewrite; source
and minified-runtime checks are both required. See [the retained boundaries](../app/BASKULE.md).

## Verification

Reconstruction records and command evidence live under ignored
`.run/evidence/upstream-v0.1.10/`. Integration acceptance requires frozen installs, translation
validation, affected checks, forward migration fixtures, web and SpaceCell builds, the space
and upstream suites, a disposable fake-model journey and independent review. Native client
acceptance is recorded separately from browser viewport checks. The pull request records the
final outcomes and platform limits. No installation deployment, restart, data wipe, paid-model
check or paid translation generation is part of this change.
