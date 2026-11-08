---
paths: ["platform/src/control/**", "platform/src/space/**", "app/apps/web/src/baskule/usage/**", "app/apps/web/src/baskule/admin/ai/**", "app/apps/web/src/routes/_chat.usage.tsx", "app/apps/web/src/routes/_chat.settings.usage.tsx"]
journeys: null
profile: "full"
checks: ["scripts/check space:usage-and-limits web"]
---
# Usage and limits

## Sub-features

Usage attribution and enforced limits.

## Open the feature

Open the account menu → Settings → Usage; admin configures limits.

## Verification

This feature has no dedicated journey; `feature:usage-limits` runs the SpaceCell usage and limits check and the web checks.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
