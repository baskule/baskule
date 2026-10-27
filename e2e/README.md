# Baskule E2E

The active browser end-to-end suite is [`v2/`](v2/README.md) (Alpha 0.2.x, against `deploy/v2`). This directory only
holds the shared Playwright dependencies (`package.json`, `node_modules/`) that `v2/run.sh` uses.

The Alpha 0.1 suite (`run.sh`, `smoke.sh`, scenarios S0–S9) targeted the retired 0.1 stack and was removed on
2026-10-23; recover it from Git history if needed. Which loop to run for a change: [development workflow](../docs/development-workflow.md).
