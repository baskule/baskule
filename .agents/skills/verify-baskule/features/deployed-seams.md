---
paths: ["deploy/**", "e2e/README.md", "e2e/fixtures/**", "e2e/infra/**", "e2e/infra-smoke.sh", "e2e/llm/**", "e2e/perf/**", "e2e/playwright.config.ts", "e2e/run.sh", "e2e/tests/**", "e2e/tsconfig.json", "e2e/ux/**", "e2e/ux-findings.md"]
journeys: null
profile: "full"
checks: ["e2e/run.sh --project lifecycle"]
ownerRun: true
---
# Deployed edge, fleet and failover

## Sub-features

Edge routing, two-node fleet and failover.

## How to get to it (user POV)

Owner-run staging stack only.

## Driving it with T3 preview or Playwright

Run `scripts/check feature:deployed-seams`. Not migrated yet: the declared check preserves the current harness coverage.

## Gotchas

Deployed-only: requires explicit owner authorization; never run against staging as a local fallback.
