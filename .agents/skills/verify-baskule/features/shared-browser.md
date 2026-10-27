---
paths: ["computerd/v2/**", "app/apps/web/src/baskule/**"]
journeys: null
profile: "full"
checks: ["scripts/check computerd"]
---
# Shared browser

## Sub-features

Shared tabs and CDP control.

## How to get to it (user POV)

Open the computer browser panel from a chat.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:shared-browser`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
