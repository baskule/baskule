---
paths: ["platform/src/space/**", "app/apps/web/src/routes/_chat.settings.scheduled-tasks.tsx", "app/apps/web/src/components/**/Scheduled*"]
journeys: null
profile: "full"
checks: ["scripts/check space:schedules features:3-schedules"]
---
# Schedules and webhooks

## Sub-features

Timers, alarms, webhook triggers.

## Open the feature

Open the account menu → Settings → Scheduled tasks, or create one through the chat tools.

## Verification

This feature has no dedicated journey; `feature:schedules-webhooks` runs the SpaceCell schedule and platform schedule checks.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
