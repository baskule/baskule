---
paths: ["platform/src/control/**", "app/apps/web/src/baskule/admin/people/*Group*"]
journeys: null
profile: "full"
checks: ["scripts/check worker web"]
---
# Groups

## Sub-features

Group membership and permissions.

## Open the feature

Open Admin → People → Groups.

## Verification

This feature has no dedicated journey; `feature:groups` runs the worker and web checks.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
