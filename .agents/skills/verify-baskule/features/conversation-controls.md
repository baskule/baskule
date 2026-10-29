---
paths: ["app/apps/server/src/baskule/**", "app/packages/provider-core/src/server/textGeneration*", "platform/dev/fake-llm/**", "platform/src/space/**", "app/apps/web/src/**/Sidebar*", "app/apps/web/src/baskule/**", "app/apps/web/src/components/chat/**", "app/apps/web/src/routes/_chat*", "app/apps/server/src/orchestration-v2/**", "app/packages/contracts/src/orchestrationV2.ts", "app/packages/provider-opencode/**", "e2e/journeys/**"]
journeys: "@feature:conversation-controls"
profile: "full"
---
# Conversation controls

## Sub-features

Rename, archive, delete, pin, unread, snooze, search, fork, queue and stop.

## How to get to it (user POV)

Open the chat row menu.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:conversation-controls`. `e2e/journeys/conversation-controls.spec.mjs` opens the chat row menu via `baskule-chat-menu-button`. Rename on one device; verify the other changes. Archive and check Archived chats; delete a different chat and verify both rows disappear. Start a long answer, click Stop generation, then reload and compare the committed partial answer. `chat-contracts.spec.mjs` covers search, snooze/unsnooze, pin, unread, fork and queue edit/cancel through client RPC.

## Gotchas

Phone menu choices can close the sidebar drawer. Reopen it to edit the `Thread title` textbox or open the account menu → Settings → Archived chats. Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
