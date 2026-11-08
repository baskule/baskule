---
paths: ["computerd/**", "app/apps/web/src/baskule/**"]
journeys: null
profile: "full"
checks: ["scripts/check computerd"]
---
# Shared browser

## Sub-features

Shared tabs and CDP control.

## Open the feature

Open the computer browser panel from a chat.

## Verification

This feature has no dedicated journey; `feature:shared-browser` runs the computerd checks.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
