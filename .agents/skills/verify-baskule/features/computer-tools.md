---
paths: ["computerd/**", "platform/src/agent/**"]
journeys: null
profile: "full"
checks: ["scripts/check agent"]
---
# Computer and tools

## Sub-features

Lazy start, exec, tool calls, persistence.

## Open the feature

Send a request that needs a tool, then open the computer panel.

## Verification

This feature has no dedicated journey; `feature:computer-tools` runs the embedded agent checks.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
