# Embedded AgentRuntime (`platform/src/agent/`)

Baskule runs **OpenCode 2.1.3 embedded** inside the same SpaceCell as T3 (`../space/`). There is one Durable Object
per space, one SQLite database and one shared SQL client for both engines. SpaceCell owns the lifecycle: it creates
the runtime, multiplexes its alarm deadline with T3's (`../space/alarms.ts`), disposes both when idle and wipes both
on space deletion.

```
T3 → env.SPACE.getByName(spaceId).fetch("http://agent/_baskule/agent/oc/<path>")
   → the SAME SpaceCell → embedded AgentRuntime → OpenCode
```

The self-request gives every agent call a live native I/O event on stock celld (issue #258), including calls that T3
makes from background fibers after a restart. It does not allocate another cell. The public Worker rejects
`/_baskule/*` paths before forwarding requests.

The boot event is retained with `waitUntil` until OpenCode closes, alongside its keepalive interval. SDK operations
and response-body pulls enter through a Promise-woken dispatcher captured in that event. Operations start
concurrently. This gives long-lived SDK services a native owner that outlives individual HTTP handlers. The workerd
build also preserves native callback origins; SQL transaction bodies keep their critical-section driver separate
from the caller.

OpenCode only creates its schema in an empty database. In a new space, SpaceCell therefore boots OpenCode before T3
creates its own tables; afterwards OpenCode stays lazy until the first agent request.

The embedded runtime receives these paths after SpaceCell strips `/_baskule/agent`:

| Path | Behavior |
|---|---|
| `/oc/*` | OpenCode HTTP API, except session creation binds the computer workspace |
| `/_baskule/debug/*` | Only with `BASKULE_AGENT_DEBUG=1` (test runner) |

SpaceCell calls `stop()` (interrupt active sessions) and `dispose()` directly.

| File | What |
|---|---|
| `index.ts` | AgentRuntime: lazy boot, session binding, tools, #258 keepalives, heartbeat and idle disposal |
| `opencode.js` | the **only** module using OpenCode SDK internals (`@opencode/sdk/dist/internal/{host,workerd}.js`); workspace provider `computer`; shared SQL client; `rg` resolved on the computer |
| `remote-spawner.js` | Effect `ChildProcessSpawner` over computerd `POST /v1/spaces/:id/exec` (NDJSON frames) and `/kill` |
| `computerd.ts` | computerd v2 client (exec, kill, status) |
| `space-bridge.ts` | OpenCode's route back to T3's MCP server (agent and preview tools) in the same SpaceCell |
| `t3-mcp.ts` | cached static tool list in front of T3's MCP server, so a chat's first step needs no round trip |
| `lazy-mcp.ts` | in-isolate MCP registry (`baskule-mcp.internal`) for `t3-mcp.ts` proxies and the sample app |
| `sample-app.ts` | the bundled interactive MCP app (`decision`) |
| `plugin-mcp.ts`, `turn-author.ts` | remote plugin tools through an in-isolate proxy; ControlCell policy per call; persisted turn identity |
| `plugin-skills.ts` | managed computer skill tree and the location skill catalog |
| `config.ts` | OpenCode config (the installation's single provider and model, capabilities, policies, agents and the assistant prompt) |
| `session.ts` | pure session-create preparation (strip nulls, `/sandbox` paths, permissions) and the model rule: a chat whose model the installation no longer offers runs on the installation's model (session create, model switch, and a session's first turn per boot) |
| (in `index.ts`) | per new chat folder: the config's MCP tools start connecting when a session is created there (its first prompt and T3's MCP registration wait for that); `GET /api/model` is answered once per boot |
| `fs-shim.js`, `node-url.js` | celld gaps: in-memory `fs.createWriteStream/createReadStream`; `pathToFileURL`/`fileURLToPath` (build plugin in `scripts/build.mjs`) |

## Tools

OpenCode's built-in `webfetch`, `websearch` and Code Mode `execute` are enabled. Tool permissions allow all actions;
the `provider.use` policies restrict model access to the installation's provider. Web fetch and Code Mode run in
the cell. Shell and file tools run on the computer. The assistant prefers search and fetch for quick lookups, and
T3's shared preview browser for interactive pages.

`websearch: { provider: "random" }` preselects OpenCode's built-in keyless providers without adding API keys or
showing its first-use provider form. Plugin MCP servers, the sample app and T3's MCP server keep `codemode: false`,
so their tools remain directly callable. Code Mode also exposes OpenCode's own catalog. Source evidence and the
browser namespace limitation are in [the tool investigation](../../../docs/agent-cell-tools.md).

## Env (vars of the `baskule` Worker)

AI settings and the key come from ControlCell's organization settings. Advanced model limits control
OpenCode's automatic compaction: it reserves the larger of 15% of the context window or 16k tokens.

| Var | Default | |
|---|---|---|
| `COMPUTERD_URL`, `COMPUTERD_TOKEN` | | computerd v2 |
| `BASKULE_AGENT_IDLE_S` | 300 | idle time before OpenCode is closed (cell evictable) |
| `BASKULE_AGENT_DEBUG` | off | `1`: debug routes + the `gpt-fake-patch` test model. Never in deployments |

celld nodes need `CELLD_V8_HEAP_LIMIT_MB` ≥ 1024 (OpenCode + T3 in one isolate) and `CELLD_FETCH_TIMEOUT_S` raised
(long exec streams), as in `deploy/v2`.

## Feedback loops

```sh
src/agent/test/run.sh                 # dev stack + 13 fake-LLM runtime checks through the merged SpaceCell + everything down (~2 min warm)
src/agent/test/run.sh --keep          # leave the shared OpenShell gateway up (faster next run), services stopped
src/agent/test/run.sh --real-llm      # the one real-model smoke turn (Mistral Large 4; log the spend)
pnpm exec vitest run src/agent              # unit tests only (from platform/; also part of `pnpm test`)
src/agent/test/devstack.sh start|reload|restart-celld|stop|down   # the stack by hand; then node src/agent/test/run.mjs [--only a,b]
```

The harness (`test/harness`) routes `/a/<spaceId>/…` to the **merged SpaceCell** at `/_baskule/agent/…`, so the checks
exercise the embedded runtime in its production composition (shared SQL client, SpaceCell-owned alarms and wipe). It
uses the fake LLM (requires the bearer key, so the key path is exercised), **computerd v2 from source** and the shared
private OpenShell gateway of the component loops (`openshell/dev-up.sh`, real `baskule-computer:0.2` sandboxes).
Each run uses fresh space ids and deletes its computers at the end. Feature-level behaviour across members (queue,
delegation, MCP apps) is `platform/test/wpf`; the deployed fleet (restart/failover with real nodes) is `e2e/v2`.
Which loop to run for a change: [development workflow](../../../docs/development-workflow.md).

Remote plugin MCP servers use only in-isolate config URLs. Each call resolves the T3 turn author (including delegated
and scheduled work), rechecks policy through ControlCell and forwards the selected account's credential. Personal
results include an account label. Plugin settings use the same reload lifecycle as AI settings. Skills live at
`/sandbox/space/plugins`, with read-only file modes, and are also registered in OpenCode's location skill service
because its workerd profile disables disk config plugins. Computer files share the agent uid; these modes do not
prevent a deliberate shell chmod.
