---
paths: ["app/apps/web/src/**"]
journeys: null
profile: "full"
checks: ["scripts/check web"]
---
# Phone layout

## Sub-features

Drawer, composer, navigation and panels.

## Open the feature

Open the app at a phone viewport; Toggle main sidebar opens navigation.

## Verification

This feature has no dedicated journey; `feature:phone-layout` runs the hosted client checks.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
