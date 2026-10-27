---
paths: ["platform/src/control/**", "app/apps/web/src/baskule/admin/people/*Group*"]
journeys: null
profile: "full"
checks: ["scripts/check worker web"]
---
# Groups

## Sub-features

Group membership and permissions.

## How to get to it (user POV)

Open Admin → Groups.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:groups`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
