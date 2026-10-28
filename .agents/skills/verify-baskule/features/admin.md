---
paths: ["platform/src/control/**", "app/apps/web/src/baskule/admin/**", "app/apps/web/src/routes/_chat.admin*"]
journeys: null
profile: "full"
checks: ["scripts/check worker web"]
---
# Administration

## Sub-features

Settings, authentication, models and health.

## How to get to it (user POV)

Open user menu → Admin. It opens as a pop-up over the chat, like Settings.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:admin`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
