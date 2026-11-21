# T3 Code v0.1.11 integration

T3 Code published stable [v0.1.11](https://github.com/pingdotgg/t3code/releases/tag/v0.1.11)
on 20 November 2026. This updates Baskule from v0.1.10, one stable release behind.
The release API confirms `draft=false` and `prerelease=false`. The tag resolves to
`59651c1761f6c63e9b6056839067066968e6a406`.

The integration starts from the complete released tree and reapplies the Baskule
changes needed from main at `be1d3b0061a49028c7dfa2f03ea4e9d967f5db01`. The release
comparison from `7d32075e3757ded707914e2450c3e392a9665765` covers 643 commits.

## Product decisions

| Area | Integration and reason |
| --- | --- |
| OpenCode | Take the released adapter fixes for answer preservation, stop handling, and stalled subscriptions. Keep the Baskule SDK and embedded runtime at 2.2.5. The newer 2.3.2 packages update the embedded Effect dependency as well as OpenCode. The integration uses the currently matched package graph. |
| Hosted platform | Keep platform sign-in, space identity, authorship, plugins, and computer routing at their existing boundaries. SpaceCell shares one SQL client with the embedded agent and keeps its multiplexed alarm and same-cell request. |
| Voice | Use the upstream recording lifecycle and controls. Hosted web and mobile use authenticated Baskule transcription and cancel in-flight work when its account or destination changes. |
| Tools | Keep missing tool-call visibility settings at `hideAll`. The decoder preserves every explicit choice saved by 0.5.3 and 0.5.4. |
| Localization | Adopt General Translation on all three clients and carry the old device language into upstream client settings. Keep Dutch and Italian. Catalog changes land with the corresponding copy and CI validates them. |
| Product scope | Keep issue and forge tools, linked environments, remote browser tunnels, other harnesses, and T3 commercial endpoints outside the supported product. |

## Persistence and compatibility

The migration head is 102. IDs 065 and 070–072 remain absent. Baskule omits 097
because its issue tracker table has no caller. Migrations 098–102 run forward
over the existing projection tables, with per-chat item totals maintained by
triggers. The supported database history includes the released 096 layout.

The client/server window stays at `0.5.4`. Preserve the released
`thread.visited` payload and keep optional capabilities behind the server's
advertised support. The compatibility guard uses `compatibility-noop`.

## Verification

Reconstruction records, migration results, and command evidence live under
ignored `.run/evidence/upstream-v0.1.11/`. Use the bundled fake model for the hosted
journey. Verify native clients separately from browser viewports. The pull
request records the final checks and platform limits.
