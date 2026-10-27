---
paths: ["app/apps/server/src/baskule/**", "app/packages/provider-core/src/server/textGeneration*", "platform/dev/fake-llm/**", "platform/src/space/**", "app/apps/web/src/baskule/**", "app/apps/web/src/components/chat/**", "app/apps/web/src/routes/_chat*", "app/apps/server/src/orchestration-v2/**", "app/packages/contracts/src/orchestrationV2.ts", "app/packages/provider-opencode/**", "e2e/journeys/**"]
journeys: "@feature:team-chat"
profile: "full"
---
# Team chat and live queue

## Sub-features

Shared messages, author identity, live delivery and queued runs.

## How to get to it (user POV)

New chat → Run on → your team.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:team-chat`. `e2e/journeys/team-chat.spec.mjs` opens two signed-in devices in a fresh team. Select that team with Run on, send a message, and verify the other member sees the row, answer and Alice attribution without reload. Close both devices during a long answer, wait for zero active runs, reopen and verify word1 and word300. `chat-contracts.spec.mjs` also drives the queue through the real RPC interface.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
