# Space restart recovery and agent alarm disposal

The release verification failure in [run 41579027015](https://github.com/baskule/baskule/actions/runs/41579027015)
exposed a SpaceCell lifecycle race. After a celld restart, the agent alarm and the plugin inventory reload can
reach the same space together. The reload calls `/_baskule/reconfigure` even when the inventory is empty.

`AgentRuntime.alarm()` first awaits its usage flush. SpaceCell previously allowed reconfiguration to dispose
that agent and clear `database` during the wait. The alarm still held the retired agent and could subsequently
call `boot()`. A replacement runtime then acquired another SQL client, while the retired agent retained the
old client's semaphore. This breaks the requirement that T3 and OpenCode share one SQL client.

The failed release log records `disposed (space disposed)` before the retired agent's boot phases. Another
agent starts after `space.booted`. Storage resets then repeat at the native transaction gate's 30-second limit.
The second agent start alone is normal for lazy OpenCode startup; the boot after disposal is the lifecycle defect.
This is a product bug. The restart harness's plugin sync exposes a valid overlap between alarms and reconfiguration.

SpaceCell now tracks the agent alarm until it settles. Disposal drains that operation before retiring its agent
and database. An agent alarm delivered during disposal waits for disposal to finish. The space alarm still runs
after the agent operation and can dispose an idle runtime without waiting on itself.

The shared SQL client, same-cell agent requests, multiplexed alarm, and existing reload behavior remain in place.
No data layout changes or data wipe are required.

## Reproduction and verification

The lifecycle regression pauses an agent alarm and starts reconfiguration. On main, the observed order is
`disposed`, then `alarm completed`. With the fix, the alarm completes before disposal. A second test covers an
alarm delivered while reconfiguration is already disposing the agent.

The unchanged `delegation-survives-restart` check also reproduced a Durable Object storage reset locally, then
recovered and passed its delivery assertions. That run reproduced the faulty lifecycle and reset, but not the
release run's full four-minute recovery timeout.

One fixed repetition restarted while the child was still starting its initial prompt. The old process recorded
`The client has disconnected`, and the child ended in `failed`. The existing check accepts a terminal failure
when the parent receives exactly one completion and the space answers the warm-up turn. Its passing result proves
recovery and delivery, not successful completion of every interrupted child. That run had no transaction gate
timeout or storage reset.

Three consecutive fresh-stack repetitions passed with the fix. Their saved celld logs contain no native
transaction gate timeout or Durable Object storage reset across the six restarts. Lint, related unit tests,
feature-map validation, and the platform typecheck also passed.

Use the fake LLM and a worktree-local stack:

```sh
source scripts/env.sh
scripts/worktree runtime
BASKULE_STACK_PROXY=0 scripts/check features:delegation-survives-restart --fresh
```

Direct loopback HTTP avoids requiring the local TLS proxy. Each check restarts celld twice, verifies recovery
without connected clients, checks exactly one parent delivery, and sends a warm-up turn afterward. Repeat the
selection and inspect the retained celld logs for storage resets as well as the check's result. Local evidence
belongs under `.run/evidence/`; raw logs and session payloads do not belong in this document.
