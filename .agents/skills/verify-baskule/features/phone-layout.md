---
paths: ["app/apps/web/src/**"]
journeys: null
profile: "full"
checks: ["scripts/check web"]
---
# Phone layout

## Sub-features

Drawer, composer, navigation and panels.

## How to get to it (user POV)

Open the app at a phone viewport; Toggle main sidebar opens navigation.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:phone-layout`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
