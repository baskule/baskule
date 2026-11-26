# T3 Code v0.1.12 integration

T3 Code published stable [v0.1.12](https://github.com/pingdotgg/t3code/releases/tag/v0.1.12)
on 25 November 2026. The tag resolves to `ca81b7b97a1c4b91e5ac25768d0f6629f37732fd`.
The previous base was v0.1.11. This integration starts from the complete v0.1.12 tree and
reapplies the Baskule changes still needed from main at `293fae49ea32169ac12b4cbc0ccbf7a887b62fd9`.

| Area | Integration |
| --- | --- |
| Chat and files | Take the released reconnect, queued-message, file preview, and document handling fixes. Preserve Baskule's account, space, authorship, plugin, and computer boundaries. |
| OpenCode | Take the released adapter improvements. Retain the matching 2.2.5 client packages and embedded runtime. Hosted spaces refresh the installation's catalog on demand without keeping separate location-scan streams open. |
| Dictation | Use upstream recording controls and queued submission. Transcribe through the authenticated Baskule endpoint and cancel on account changes. Omit the Apple Speech helper and unsupported settings. |
| Settings and language | Keep tool calls hidden by default and preserve explicit settings. Reuse the released General Translation changes and retain Dutch, Italian, and device language preferences. |
| Scope | Keep beta workflows, linked machines, forge features, agent feedback, and other drivers outside Baskule. Keep the underlying task-folder and chat-history changes where existing operations use them. Retain the existing side-chat panel identity for saved parent views and tabs. |

[The application guide](../app/BASKULE.md#migration-boundary) records the migration
manifest and omitted IDs. The new head is 116. The release retains the 0.5.4 client
and server compatibility floor. The retention worker now purges content belonging
to previously deleted chats. Take an installation backup before upgrading, using
the [installation guide](install.md). Restoring that backup is the rollback path.

The hosted runtime keeps one shared SQL client, the multiplexed alarm, and the same-cell
request for embedded OpenCode. The cell reads finite OpenCode probe bodies before returning them
to the provider check. This lets the request finish if a space stops during discovery.
The application uses Effect 4.1.5. The bundle rewrite
shares the unchanged HTTP codec factories while leaving request redaction in the
request handler.

Hosted `request_secret` advertises and accepts the default `secretRef` flow. File
delivery is unavailable because agent commands run on the space computer and the
secret file would live in SpaceCell storage. The persisted T3 MCP catalog uses the
bundled server's hash so the first chat after an upgrade sees the current tools.
