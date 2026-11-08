---
paths: ["platform/src/agent/**", "app/apps/server/src/orchestration-v2/**", "app/apps/server/src/mcp/OrchestratorMcpService.ts", "app/apps/web/src/components/chat/**"]
journeys: null
profile: "full"
checks: ["scripts/check features"]
---
# Delegation

## Sub-features

Child tasks and result handoff.

## Open the feature

Ask the agent to delegate a task; inspect its child result.

## Verification

This feature has no dedicated journey; `feature:delegation` runs the platform feature checks.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
