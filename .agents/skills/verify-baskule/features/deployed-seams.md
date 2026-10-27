---
paths: ["deploy/v2/**", "e2e/v2/**"]
journeys: null
profile: "full"
checks: ["e2e/v2/run.sh --project lifecycle"]
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
