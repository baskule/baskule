# T3 Code v0.1.13 integration

T3 Code published stable [v0.1.13](https://github.com/pingdotgg/t3code/releases/tag/v0.1.13)
on 26 November 2026. The tag resolves to `bc0f04da94f64b5e487c598761a43b4cf06b2ac9`.
The integration starts from the complete release and reapplies the Baskule
behavior still needed from main at `de891cfbd391a75e9befe2d367fe3c96dc9a5871`.

| Area | Integration |
| --- | --- |
| Chat and files | Adopt prompt, file preview, attachment decoding, and navigation fixes. Mobile uses authorized local preview bytes for legacy text encodings. |
| OpenCode | Keep the 2.2.5 client packages and embedded runtime. Carry over prompt recovery and remote usage fixes. Standalone OpenCode follows skill updates, and hosted reads keep their scoped scan. |
| Dictation and settings | Reuse upstream dictation, including finishing citation dictation before closing the editor. Keep platform transcription, hide tool activity by default, preserve explicit settings, and reuse released translations with Dutch and Italian catalogs. |
| Product scope | Preserve authentication, spaces, authorship, plugins, and per-space computers. Keep excluded drivers, forge workflows, and linked environments outside the supported app. |

The release adds workflow migrations 118 and 119. Both are omitted because
Baskule does not ship their workflow tables. The application migration head stays
at 116 and the compatibility floor stays at 0.5.4. The retention worker ignores
the old compaction timestamp for its first pass and purges already-deleted chat
content. Back up the installation before upgrading. See [installation](install.md)
and the [migration manifest](../app/BASKULE.md#migration-boundary).
