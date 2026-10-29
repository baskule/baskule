---
paths: ["platform/src/space/**", "app/apps/web/src/routes/_chat.settings.scheduled-tasks.tsx", "app/apps/web/src/components/**/Scheduled*"]
journeys: null
profile: "full"
checks: ["scripts/check space:schedules features:3-schedules"]
---
# Schedules and webhooks

## Sub-features

Timers, alarms, webhook triggers.

## How to get to it (user POV)

Open the account menu → Settings → Scheduled tasks, or create one through the chat tools.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:schedules-webhooks`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
