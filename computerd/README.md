# computerd

Stateless HTTP bridge from the celld cells to OpenShell (architecture E4), with organization policy read from the platform.
Node 24 + TypeScript (run directly by Node's type stripping), `@grpc/grpc-js` + `@grpc/proto-loader` with the
OpenShell protos vendored from our fork (`proto/`, `scripts/vendor-protos.sh`), `ws` for WebSockets.

```sh
pnpm install --frozen-lockfile
pnpm test                    # unit tests against a fake gRPC gateway (28 tests, ~18 s)
pnpm run typecheck
./test/integration.sh       # against the REAL gateway (shared openshell/dev-up.sh, gateway ports 47510–47511, computerd 47502), 13 tests, ~40 s warm
docker build --network host -t baskule-computerd:local -f Dockerfile ..
```

Feedback loops: `pnpm test` (fake gateway: execs run locally under a temp sandbox root, so the real wrapper, kill,
file and confinement scripts are exercised), `test/integration.sh` (real OpenShell, our image, our policy), and
`e2e/infra-smoke.sh` (the whole stack; it runs `test/integration.ts` inside the stack network).

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `COMPUTERD_INSTANCE` | empty (unscoped) | optional gateway label value (1–63 ASCII alphanumeric, `.`, `_`, `-`; alphanumeric ends); scopes creation, adoption and lifecycle lookups to `baskule.instance=<id>` |
| `COMPUTERD_TOKEN` | required (16+ chars) | bearer token of every `/v1` call |
| `COMPUTERD_PORT`, `COMPUTERD_HOST` | `47094`, `0.0.0.0` | listener |
| `OPENSHELL_GATEWAY` | `baskule-openshell:47095` | gateway gRPC (plaintext, internal network) |
| `OPENSHELL_VOLUMES_URL`, `OPENSHELL_VOLUMES_TOKEN` | `http://baskule-openshell:47096`, required | per-space volume helper of `baskule-openshell` |
| `COMPUTER_IMAGE` | `baskule-computer:local` | sandbox image |
| `COMPUTER_CPUS`, `COMPUTER_MEMORY` | `2`, `3Gi` | per-computer limits (Docker driver) |
| `IDLE_MINUTES` | `10` | standalone/component-test idle stop; the deployed stack uses organization settings |
| `MAX_STREAMS_PER_COMPUTER` | `30` | concurrent exec/cdp/files streams per computer (OpenShell caps relays at 32 per sandbox) |
| `PRODUCT_SETTINGS_URL` | empty (standalone component tests) | authenticated platform runtime-settings URL; supplies idle policy before each idle check |
| `READY_TIMEOUT_MS`, `MAX_PUT_BYTES`, `BASKULE_CDP_PORT`, `LOG_LEVEL` | 180000, 1 GiB, 9222, info | |
| `OTLP_TRACES_URL` | empty (no export) | OTLP/HTTP traces endpoint (`…/v1/traces`): one span per API request and per computer lifecycle step (`src/trace.ts`), children of an incoming `traceparent` |

## API (all `/v1` routes: `Authorization: Bearer <COMPUTERD_TOKEN>`)

Errors are `{"error": "<message>"}` with 400 (bad input), 401, 403 (path outside `/sandbox`), 404, 409, 413, 416,
426 (WebSocket route called without upgrade), 429 (too many streams on this computer), 503 (computer cannot be made
ready), 502 (gateway/browser failure). `:id` is the space id, `[A-Za-z0-9_-]{1,64}`.

| Route | Body / query | Answer |
|---|---|---|
| `GET /healthz` (no auth) | | `{ok:true}` |
| `POST /v1/spaces/:id/computer/ensure` | `{"keep"?: boolean}` | status + `{created, started, ms}`; creates/starts/recovers the computer and waits for Ready. `keep: true` pins it (no idle stop) until `keep:false` or stop |
| `POST /v1/spaces/:id/computer/stop` | | status after the stop completed |
| `POST /v1/spaces/:id/computer/delete` | `{"confirm": "<spaceId>"}` (required, must equal `:id`, else 400) | `{spaceId, sandbox, sandboxDeleted, volumeDeleted}`: deletes the sandbox, waits until it is gone, then deletes the space volume (`/sandbox/space`: home, chats) through the volume helper (retries while Docker still reports it in use). **Irreversible.** Idempotent: a second call answers `false, false`. A later `ensure` creates a fresh computer. 502 if OpenShell or the helper fails (safe to retry). Used by SpaceCell `/_baskule/delete` |
| `GET /v1/spaces/:id/computer` | | `{spaceId, sandbox, phase: absent\|starting\|ready\|stopping\|stopped\|error, running, image, activeStreams, keep, lastActivity, idleStopAt, error}` (never starts it) |
| `POST /v1/spaces/:id/exec` | see below | `application/x-ndjson` frames; header `x-exec-id` |
| `POST /v1/spaces/:id/kill` | `{"id", "signal"?: TERM\|KILL\|INT\|HUP\|QUIT\|USR1\|USR2, "graceMs"?}` | `{id, killed}`; TERM escalates to KILL after `graceMs` (default 3000, 0 = never) |
| `GET /v1/spaces/:id/files?path=` | `&stat=1`; header `Range: bytes=a-b \| a- \| -n` | file: bytes (`200`/`206`, `Content-Range`, `Accept-Ranges`, `Last-Modified`, `x-baskule-file-mode`); directory: `{path, type:"dir", size, mtime, mode, entries:[{name, type: file\|dir\|symlink\|other, size, mtime, mode}]}` (dirs first); `stat=1`: `{path, type, size, mtime, mode}` |
| `PUT /v1/spaces/:id/files?path=` | body = bytes (streamed); `&type=dir` creates a directory | `{path, type, size}`; parents are created; the write is atomic (temp file + rename) and checked against `Content-Length` |
| `GET /v1/spaces/:id/cdp[?target=<targetId>]` (WebSocket) | | tunnel to the computer's shared Chromium DevTools: the browser endpoint, or `/devtools/page/<targetId>` with `target` |
| `GET /v1/spaces/:id/cdp/json[/list]`, `/cdp/json/version` | | the DevTools HTTP discovery JSON (its `webSocketDebuggerUrl`s are computer-local: connect through `/cdp?target=`) |
| `GET /v1/spaces/:id/browser/ws` (WebSocket) | query passed through | the image's `baskule-browser-bridge` (started on demand) on the same shared browser: what T3's browser tools use |

Every route except `GET .../computer`, `kill`, `stop` and `delete` makes the computer ready first (lazy start).
An idle stop first clears regenerable caches on the volume (pip, uv, npm and Bun download caches; the shared
browser's HTTP, code and GPU caches), best effort and bounded to 15 s; installs, browser profiles and chats are kept. Activity on
exec/files/cdp (and `ensure`) resets the idle clock; a running stream or `keep` prevents the idle stop.

### Exec

Request, either:
- `Content-Type: application/json`: `{"argv": [..], "cwd"?: "/abs", "env"?: {..}, "stdin"?: "<base64>", "id"?: "..", "timeoutMs"?: N}`;
- or `Content-Type: application/octet-stream` with the same JSON (without `stdin`) in header `x-baskule-exec`
  (JSON or base64url JSON); the body is streamed to stdin.

Response frames (one JSON object per line), ground-rules contract:
`{"t":"o","d":"<base64>"}` stdout, `{"t":"e","d":"<base64>"}` stderr, then `{"t":"x","code":N}`, or
`{"t":"err","msg":".."}` (gateway/transport failure; no exit code known). A process killed by a signal usually
exits with the signal number (e.g. 15) as reported by `setsid -w`.

Semantics:
- **argv only**, run without a login shell (OpenShell shell-escapes it; the assembled command must stay < 256 KiB,
  computerd rejects argv > 200 KiB: put payloads on stdin).
- **Environment**: every exec gets `HOME=/sandbox/space/home`, `PATH` (with `~/.local/bin`, `~/.bun/bin`),
  `LANG=en_US.UTF-8`, `TZ`, `NPM_CONFIG_PREFIX`, `BUN_INSTALL`, `CHROME_PATH` (OpenShell does not apply the image
  `ENV` to execs). Caller `env` is filtered by an **allowlist**: `PATH HOME LANG LANGUAGE TERM TZ COLUMNS LINES
  NO_COLOR FORCE_COLOR CI PAGER EDITOR VISUAL TMPDIR NODE_ENV NODE_OPTIONS DEBIAN_FRONTEND USER SHELL VIRTUAL_ENV`
  and prefixes `LC_ PYTHON PIP_ NPM_CONFIG_ npm_config_ BUN_ GIT_ OPENCODE BASKULE_ UV_`; keys must be shell
  identifiers; `OPENSHELL_*` and `LD_*` are refused. Other keys are silently dropped.
- **stdin** is sent in 256 KiB gRPC messages (OpenShell caps messages at 1 MiB), then closed (EOF).
- **Process group and kill.** Each exec runs as `setsid -w sh -c '<record pgid in /tmp/.osj/<id>>; "$@"'`.
  OpenShell has no kill RPC, cancelling a stream leaves the process running, **and its seccomp filter refuses
  `kill()` on a process group** (verified: EPERM), so `kill` runs a second exec that enumerates the group
  (`pgrep -g`) and signals each pid. The same happens when the HTTP client disconnects before the exit (TERM, KILL
  after 3 s) and on `timeoutMs`.
- `id` (optional, `[A-Za-z0-9_-]{1,64}`, default a UUID) names the exec for `kill`; 409 if already running here.
- At most `MAX_STREAMS_PER_COMPUTER` concurrent streams per computer (exec + cdp + files): 429 beyond.

### Files

Paths must be absolute and under `/sandbox`; any `..` segment is refused (400) and the path is normalized. Inside the
computer the path is resolved with `realpath -m` and checked again, so a symlink cannot escape (403). Scripts get
paths as positional arguments only. Listing and reading run in one exec.

### Shared browser and CDP

The image's `baskule-browser ensure` starts one headless Chromium per computer with DevTools on
`127.0.0.1:9222` (inside the computer) and a persistent profile in `~/.baskule/chromium`. The `cdp` routes run it on
demand, then reach port 9222 through OpenShell's **`ForwardTcp`** RPC (a TCP stream to a loopback port inside the
sandbox), over which computerd speaks HTTP and WebSocket. No exposed service, no relay process. The agent drives the
same browser through T3's preview MCP (`browser/ws`, the image's `baskule-browser-bridge`), so what the agent drives
is what members see.

## Lifecycle

- One sandbox per space: `os-<spaceId>` if the id is a DNS label of at most 16 characters, else `os-` + the first 16
  hex chars of sha256(spaceId) (OpenShell caps sandbox names at 19). Label `baskule.managed=true`, annotation
  `baskule.space=<spaceId>`.
- Create: volume `baskule-space-<suffix>` via the volume helper (labelled for OpenShell's resource admission), then
  `CreateSandbox` with image, `sleep infinity`, `limits {cpu, memory}`, the volume at `/sandbox/space` (Docker
  `driver_config`) and the policy of `src/policy.ts` (= `openshell/policies/computer.yaml`: `public_internet: true`,
  ports 80/443/22, `tls: skip`, uid 1000).
- Ensure: one `GetSandbox` per call; Stopped → `StartSandbox`; Error → stop, wait, start (up to 3 times; the known
  OpenShell race); wait Ready; after every (re)start, first exec `mkdir -p /sandbox/space/home /sandbox/space/chats`.
  Concurrent ensures share one operation.
- Idle stop: every `min(15 s, IDLE/4)`, computers with no stream, no keep and no activity for `IDLE_MINUTES` are
  stopped. On boot and every minute, running managed sandboxes unknown to this process are adopted (their idle clock
  starts then), so a computerd restart never leaves computers running forever.
- State is soft (activity, counts, keep): restarting computerd loses `keep` flags and resets idle clocks only.

When `COMPUTERD_INSTANCE` is set, both sandbox metadata and template carry its instance label. Adoption selects
`baskule.managed=true,baskule.instance=<id>`; direct lifecycle lookups reject sandboxes owned by another instance
(including unlabelled sandboxes). Sandbox and volume names use the first 16 hex characters of
`sha256(JSON.stringify([instance, spaceId]))` as their suffix (`os-<hash>`, `baskule-space-<hash>`). Both resources
are distinct when stacks reuse a space ID. The 19-character sandbox name fits OpenShell
(`vendor/openshell/crates/openshell-server/src/grpc/mod.rs`, `MAX_ROUTABLE_NAME_LEN`); the volume suffix fits the
helper's 48-character `[a-z0-9-]` limit (`openshell/images/gateway/volumes.py`, `NAME`).
When unset or empty, names, labels and adoption retain the original unscoped behavior: use scoping on
every computerd sharing a gateway. There is no data wipe or migration.

The vendored gateway supports multiple workspaces (`vendor/openshell/crates/openshell-server/src/grpc/workspace.rs`,
`resolve_workspace` and `handle_create_workspace`) and comma-separated equality selectors (`grpc/validation.rs`,
`validate_label_selector`; `persistence/mod.rs`, `parse_label_selector`). Instance scoping uses labels to keep the
existing default workspace and avoid workspace provisioning changes.

## Measured (loaded development host, real gateway)

Create → Ready 1.0–2.3 s (image local); exec warm 25–110 ms; stop 0.3–15 s; start + first exec 1.0–1.7 s; Playwright
MCP initialize + tools/list 2.5–4.5 s cold; delete (sandbox + volume) 0.7–0.8 s; CDP `Target.getTargets` 0.35 s including the browser start.
