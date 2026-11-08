---
paths: ["platform/src/control/**", "app/apps/web/src/baskule/admin/**", "app/apps/web/src/routes/_chat.admin*"]
journeys: null
profile: "full"
checks: ["scripts/check worker web"]
---
# Administration

## Sub-features

Settings, authentication, models and health.

## Open the feature

Open user menu → Admin. It opens as a pop-up over the chat, like Settings.

## Verification

This feature has no dedicated journey; `feature:admin` runs the worker and web checks.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
