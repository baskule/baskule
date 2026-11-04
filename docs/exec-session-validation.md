# Exec session validation

Local validation on 2026-11-04, branch `computers-without-openshell`:

- Computerd unit suite: 63 passed. The local agent test covers stdout/stderr,
  exit status, cwd/env, 4 MiB stdin, concurrent commands, an unread 8 MiB output
  alongside a small command, direct and pid-file kills, spawn failure, signal
  status, agent death and session replacement.
- Docker integration: 13 passed, including Files, browser access, persistence,
  idle stop and network isolation. Its build ships `src/agent/agent.mjs`.
- `scripts/check plan --base HEAD` selected lint, feature coverage, computerd
  tests/typecheck, script syntax and documentation links. All passed after
  removing an unused wrapper constant and rerunning lint.
- `BENCH=1 computerd/test/integration.sh`: five benchmark runs, 100 warm `true`
  requests through HTTP, p50 22.81 ms, p95 57.03 ms. The under-15 ms target
  was **not met** on this host. Concurrent static checks ran during part of
  the benchmark; these numbers are not an isolated performance comparison.
- Separate local child-process session client: 100 warm `true` requests,
  p50 8.41 ms, p95 15.00 ms.

The task supplied an approximately 106 ms local Docker Engine exec baseline;
no matched before-change HTTP benchmark was run here. Kubernetes was not deployed
or measured. GKE latency remains for the owner to verify.

Raw local evidence is under ignored `.run/`: `session-check-final.log`,
`session-lint-final.log`, `session-tests-final.log`, and
`session-integration-final.log`. The integration harness cleaned up its stack.
