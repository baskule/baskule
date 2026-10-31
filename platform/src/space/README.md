# platform/src/space — SpaceCell

One Durable Object per space (name = spaceId) running T3 Code's server, trimmed and built for workerd from the fork
(`app/apps/server/src/baskule/workerd/`), and the embedded OpenCode agent (`../agent/`), on one SQLite database
through one shared SQL client. Contract: `platform/src/shared/contract.ts` and `platform/README.md`.

## Build

The T3 bundle is a build artifact, not committed:

```sh
T3_APP_DIR=<path-to-app-checkout> src/space/sync-bundle.sh   # → src/space/t3/space-cell.js (~16 MiB, gitignored)
pnpm run build                                                      # the Worker imports it (lazily, on first boot)
```

`T3_APP_DIR` defaults to the repository's `app/` (the fork), with dependencies installed
(`CI=1 pnpm install`). `t3/space-cell.d.ts` declares the bundle's API; keep it in sync with
`apps/server/src/baskule/workerd/spaceServer.ts`.

## Feedback loop (one command)

```sh
node src/space/test/run.mjs [--sync] [--keep] [--only a,b] [--skip-schedule]   # ≈ 1.5 min, 12 checks, no Docker
```

It starts the fake LLM (:47551), a fake computerd (`test/fake-computerd.mjs`, :47552, the computerd files/exec
subset over `test/.run/computers/<space>`) and `celld dev` on `test/harness/` (:47550, clean state; Worker
`entry.ts` plays the front: it sets `x-baskule-base`, the test sets `x-baskule-identity`; the SpaceCell is the
production class with its embedded OpenCode; `TestControlCell` supplies organization settings and answers the recheck). No Docker. Checks:
identity required (missing/forged/ticket of another identity), route allowlist, a streamed turn with the author
stamped, RPC allowlist, rename/search/snooze/pin/unread/queue edit+cancel/stop/archive, files (computer untouched while
chatting; write/list/read/download through computerd; attachment upload and download), push revoke and 60 s recheck,
webhook, a schedule fired by the DO alarm while the space was asleep, persistence across a celld restart (environment
id, history, chat folder, follow-up turn), two spaces isolated in one isolate and delete, status/revoke without boot.
`--sync` rebuilds the bundle first. Logs: `test/.run/*.log`. `test/devstack.sh start|stop` runs the same stack by hand.

## Lifecycle

- T3 boots on the first client request, webhook or due alarm; never for `/_baskule/status` or `/revoke`. In a new
  space OpenCode boots first: it only creates its schema in an empty database. Otherwise OpenCode boots on the first
  agent request, which T3 sends through this cell's own stub (`/_baskule/agent/*`, a live celld event, #258).
- #258: the boot events are retained with `waitUntil` until their runtimes close, alongside their keepalive
  intervals. Each RPC WebSocket retains its native event until its handler scope finishes. SDK calls and response
  body pulls enter through OpenCode's retained boot event; workerd Effect callbacks preserve their native origin.
- One alarm multiplexes the 60 s socket recheck, a 10 s heartbeat while runs are active, the next scheduled task or
  snooze, and the idle check (5 min without request, socket or active run → T3 and OpenCode disposed so the cell can
  be evicted). OpenCode's own heartbeat/idle deadline shares the alarm (`alarms.ts`: one persisted deadline per owner).
- `/_baskule/stop` stops active threads and OpenCode sessions, stops the computer (computerd `computer/stop`) and
  disposes T3. `/_baskule/delete` disposes both runtimes, deletes the computer (`computer/delete`) and
  `deleteAll()`s the cell; 502 if the computer deletion fails.
  `/_baskule/recheck` runs the recheck now (ops/tests).
- If celld hands the cell to another node while T3 still runs here (`no db for <cell>`), this copy disposes itself.

Vars: `COMPUTERD_URL`, `COMPUTERD_TOKEN`, `PUBLIC_ORIGINS` (first one
makes webhook URLs absolute), `BASKULE_LOG_LEVEL` (default `Warn`), and the agent's vars (`../agent/README.md`).
