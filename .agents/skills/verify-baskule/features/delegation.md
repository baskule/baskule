---
paths: ["platform/src/agent/**", "app/apps/server/src/orchestration-v2/**", "app/apps/server/src/mcp/OrchestratorMcpService.ts", "app/apps/web/src/components/chat/**"]
journeys: null
profile: "full"
checks: ["scripts/check features"]
---
# Delegation

## Sub-features

Child tasks and result handoff.

## How to get to it (user POV)

Ask the agent to delegate a task; inspect its child result.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:delegation`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
