---
paths: ["deploy/**", "e2e/README.md", "e2e/fixtures/**", "e2e/infra/**", "e2e/infra-smoke.sh", "e2e/llm/**", "e2e/perf/**", "e2e/playwright.config.ts", "e2e/run.sh", "e2e/tests/**", "e2e/tsconfig.json", "e2e/ux/**"]
journeys: null
profile: "full"
checks: ["e2e/run.sh --project lifecycle"]
liveOnly: true
---
# Deployed edge, fleet and failover

## Sub-features

Edge routing, two-node celld fleet, restart persistence, and failover.

## Open the feature

Use an explicitly configured test installation managed by the installation's operator.
Supply administrator credentials with `E2E_LOGIN_EMAIL` and `E2E_LOGIN_PASSWORD`, and
select the browser origin with `E2E_BASE_URL`. The runner also uses source Compose
services, so run it where that test installation is managed.

## Verification

Run `scripts/check feature:deployed-seams --live` after preparing the installation.
The check can restart services and change organization model routing and idle settings.
See the [e2e guide](../../../../e2e/README.md) for prerequisites and restoration behavior.

## Gotchas

The `liveOnly` flag excludes this feature from disposable release journeys and requires
`--live` for explicit feature runs. Ordinary local checks use the worktree stack.
If a port is busy, identify the process using it; never stop another run or worktree to free it.
