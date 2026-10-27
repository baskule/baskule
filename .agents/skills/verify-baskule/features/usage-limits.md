---
paths: ["platform/src/control/**", "platform/src/space/**", "app/apps/web/src/baskule/usage/**", "app/apps/web/src/baskule/admin/ai/**", "app/apps/web/src/routes/usage.tsx", "app/apps/web/src/routes/settings.usage.tsx"]
journeys: null
profile: "full"
checks: ["scripts/check space:usage-and-limits web"]
---
# Usage and limits

## Sub-features

Usage attribution and enforced limits.

## How to get to it (user POV)

Open user menu → Usage; admin configures limits.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:usage-limits`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
