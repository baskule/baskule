---
paths: ["app/apps/server/src/baskule/**", "app/packages/provider-core/src/server/textGeneration*", "platform/dev/fake-llm/**", "platform/src/space/**", "platform/src/agent/**", "app/apps/web/src/**/Chat*", "app/apps/web/src/**/Composer*", "app/apps/web/src/baskule/**", "app/apps/web/src/components/chat/**", "app/apps/web/src/routes/_chat*", "app/apps/server/src/orchestration-v2/**", "app/packages/contracts/src/orchestrationV2.ts", "app/packages/provider-opencode/**", "e2e/journeys/**"]
journeys: "@feature:personal-chat"
profile: "full"
---
# Personal chat

## Sub-features

Draft home, space picker, streaming, follow-up and lazy computer startup.

## How to get to it (user POV)

New chat → Run on → Personal.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:personal-chat`. `e2e/journeys/personal-chat.spec.mjs` checks home, the Run on picker (Personal first), streaming and a second turn. `chat-contracts.spec.mjs` checks the configured catalog, retired selection, stamped author, title and session startup. In preview: choose Personal, send `Hello [[fake:text hello back]]`, and wait for the assistant answer. The sidebar must group the new row under Personal; the computer must remain stopped.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
