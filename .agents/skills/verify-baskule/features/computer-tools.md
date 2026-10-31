---
paths: ["computerd/**", "platform/src/agent/**"]
journeys: null
profile: "full"
checks: ["scripts/check agent"]
---
# Computer and tools

## Sub-features

Lazy start, exec, tool calls, persistence.

## How to get to it (user POV)

Send a request that needs a tool, then open the computer panel.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:computer-tools`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Do not assume existing users, spaces or computers. Legacy checks may own fixed ports; do not kill another run to free them.
