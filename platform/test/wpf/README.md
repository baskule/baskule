# Extended feature feedback loop

This runs against the real Worker, ControlCell, SpaceCell with T3 and embedded OpenCode, the hosted web
client, shared development OpenShell computers and a deterministic fake model. No real model tokens are spent.

```sh
source scripts/env.sh
scripts/check features
# Or select checks against a stack you started:
scripts/stack up --profile full --clean
NODE_EXTRA_CA_CERTS="$HOME/.portless/ca.pem" node platform/test/wpf/run.mjs --only 6-plugins
scripts/stack down --purge
```

The runner reads URLs, ports, the computerd token and admin credentials from `.run/stack/stack.json`.
See [stack profiles and prerequisites](../../../stack/README.md). `--list` lists checks; `--only name,capability`
selects them. Results are written to `platform/test/wpf/.run/results-<run>.json` and `results.json`.
Stack logs and state are under `.run/stack/`. Each run uses its own ports, including its MCP fixture server.

Checks cover cross-member chat search, queue edit/reorder/cancel/steer, command
idempotency, read/pin/snooze, alarm wake without clients, questions/approvals,
bounded history, failure status, app-owned delegation and completion delivery,
scheduled tasks/webhook replay/rotation, and a real interactive MCP application. An interval schedule waking an
asleep space is proven by the SpaceCell runner (`platform/src/space/test/run.mjs`), not repeated here.
Individual check failures are reported rather than converted into a successful
empty response. Browser UI acceptance remains part of `e2e`.
