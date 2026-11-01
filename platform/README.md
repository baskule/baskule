# platform/ — the Baskule celld app

One celld app (`wrangler.json`, Worker `baskule`):

| Part | Code | Owner |
|---|---|---|
| Worker `baskule` (front: static bundle, auth, routing) | `src/worker.ts` | WP-C |
| `ControlCell` (singleton DO `control`: Better Auth + spaces, members, invitations, plugins and groups) | `src/control/` | WP-C |
| `SpaceCell` (one active DO per space: T3 + embedded OpenCode, shared SQLite client and alarms) | `src/space/`, `src/agent/` | WP-B / WP-D |
| Shared contract, identity codec, 60 s recheck helper | `src/shared/` | WP-C (contract changes: orchestrator) |
| Fake LLM | `dev/fake-llm/server.mjs` | WP-C |

T3 requests enter the same SpaceCell through its private `/_baskule/agent/*` route before invoking the embedded
runtime. This fresh request boundary keeps native I/O alive on stock celld; it does not allocate a second cell. The
public Worker blocks these internal paths. In a new space OpenCode boots before T3, because it only creates its schema
in an empty database. Details: [`src/agent/README.md`](src/agent/README.md).

## Commands (one feedback loop each)

From the repository root, `scripts/check` picks these for a diff (`scripts/check plan`; see
[development workflow](../docs/development-workflow.md)): `fast` runs the related unit tests and the typecheck,
`scripts/check worker|space|agent|features` the component loops below.

```sh
pnpm install --frozen-lockfile
pnpm run build                 # dist/worker.js (esbuild) + dist/web (+ dist/web/downloads)
pnpm test                      # vitest: ControlCell, Worker security, recheck, SpaceCell lifecycle, agent runtime/migration (63 tests, ≈20 s)
pnpm run test:integration      # test/integration.sh: real celld dev on :47620, 76 checks, then stops (≈30 s)
node src/space/test/run.mjs   # SpaceCell runner: merged cell + fake computerd + fake LLM, 12 checks (≈1.5 min)
src/agent/test/run.sh         # embedded agent runner: real computerd + shared OpenShell gateway, 12 checks (≈2 min)
../scripts/check features     # real hosted app + fake model + real computers
pnpm run typecheck
../scripts/stack up           # isolated real app; --profile light or rustfs
../scripts/stack up --profile rustfs   # production-mode celld on shared dev RustFS
../scripts/stack down         # stop this worktree; shared infrastructure remains
node dev/fake-llm/server.mjs --port 47601
```

`CELLD_BIN` overrides the celld binary (default `.tools/bin/celld` at the repository root, then `celld` on PATH; stock 0.6.3). Run `../scripts/worktree host-init` to extract the pinned official binary first. The build takes
`BASKULE_WEB_DIR` (the web bundle to serve; default `web-placeholder/`), `BASKULE_DOWNLOADS_DIR` (files published
under `/downloads/`) and `BASKULE_ENTRY`/`BASKULE_OUT` (used by the integration test).

See [worktree stack profiles](../stack/README.md) for state, admin credentials, ports and teardown.

## Vars (`wrangler.json` → `vars`; `.dev.vars` in dev)

| Var | Meaning |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | first boot only: creates the admin when no admin exists. Remove the password from the deployment afterwards. |
| `AUTH_CONFIG` | resolved installation authentication JSON; see [installation settings](../docs/installation-settings.md) |
| `PUBLIC_ORIGINS` | comma-separated exact origins accepted besides the request's own (e.g. `http://100.64.0.42:47090`) |
| `AUTH_SECRET` | optional; when empty ControlCell generates one at first boot and keeps it in its SQLite (same trust boundary as the session table) |
| `AUTH_RATE_LIMIT` | `0` disables Better Auth rate limiting (tests only) |
| `COMPUTERD_URL`, `COMPUTERD_TOKEN` | connection to computerd |

celld has no secrets mechanism (#190): vars live in the bucket deployment. Generate them at deploy time, never commit them.

Organization and AI settings are administered through `/api/baskule/admin/settings` (GET/PATCH), stored in ControlCell.
The public discovery document `/.well-known/baskule` names the installation and describes its enabled login
methods without credentials. Private
`/_baskule/settings` supplies SpaceCells with AI settings, the key, and space-scoped plugin definitions and skill files.
Plugins and manual groups are administered in ControlCell; all installations start disabled. The Everyone group
includes every current and future user, and group permissions combine additively. Group capabilities determine
space creation; `/me` exposes the resolved capability. Plugin/group contracts are in
`app/packages/contracts/src/baskule-plugins.ts`. computerd reads idle policy only at
`/api/baskule/runtime-settings`, authenticated with its service token. Full setup: [installation settings](../docs/installation-settings.md).

## Routes (one origin)

| Path | Handled by | Auth |
|---|---|---|
| `/auth/*` | Better Auth in ControlCell (`basePath: /auth`) | Better Auth; Origin check on state-changing calls. `/auth/admin/*` and `/auth/sign-up/*` answer 404. |
| `/api/baskule/*` | ControlCell (`src/control/service.ts`) | session (cookie or `Authorization: Bearer`) |
| `/api/baskule/downloads` | Worker | public |
| `/.well-known/baskule` | ControlCell | public: `{product: "baskule", name}` (the organisation), so a client can check an address before connecting |
| `/s/<spaceId>/*` | SpaceCell `<spaceId>` | Origin + session + membership on **every** request and upgrade |
| `/hooks/<spaceId>/*` | SpaceCell `<spaceId>` at `/api/hooks/*` | public (the hook's own token, checked by T3) |
| `/downloads/`, `/downloads/<file>` | Worker (static files from `BASKULE_DOWNLOADS_DIR`) | public |
| anything else | static web bundle, SPA fallback to `index.html` | public |

### Sessions (for WP-E, WP-G)

- Sign in: `POST /auth/sign-in/email {email, password}`. Response: cookie `baskule.session_token` (HttpOnly,
  SameSite=Lax) **and** header `set-auth-token: <signed token>` (the bearer plugin, `requireSignature: true`).
- Web/desktop: the cookie. Android (and any native client): `Authorization: Bearer <set-auth-token value>`, no Origin.
- Sign out: `POST /auth/sign-out` (also sends `Clear-Site-Data: "cache","storage"`, honoured on HTTPS/localhost only:
  the web client should clear its own caches too). Change password: `POST /auth/change-password
  {currentPassword, newPassword, revokeOtherSessions}`. Reset: `POST /auth/reset-password {token, newPassword}`.
- **Origin rule** (review H4), for POST/PUT/PATCH/DELETE and every WebSocket upgrade: an `Origin` header must equal the
  request's own origin or one of `PUBLIC_ORIGINS` (`null` refused). Without `Origin`, only requests that carry no
  `baskule.*` cookie are accepted (bearer clients).
- **Connecting a device** (no server is built into the clients): a signed-in person calls `POST /auth/connect/code`
  (session) and gets `{code, expiresAt}`: 256 random bits, single use, 10 minutes, stored as a SHA-256 hash in Better
  Auth's `verification` table (`src/control/auth.ts`, plugin `baskule-connect`). The clients turn it into a
  connection link `<origin>/link#code=<code>` (QR code, paste) or `baskule://connect?server=<origin>&code=<code>`
  (desktop hand-off). `POST /auth/connect/redeem {code}` (public, 10/min per IP) consumes it and creates a **new**
  session for that person: cookie and `set-auth-token`, like a sign-in. Unknown, used, expired or deactivated → 404.
  Native clients show the server's name (`/.well-known/baskule`) and ask before redeeming a link they did not
  type: a link must not silently repoint an app to someone else's server. Browser sign-in for native apps
  (`/api/baskule/native-login*`) uses the same codes: approving in the browser issues one, the app's poll redeems it.
- Sessions are never cached in cookies (revocation must be immediate). Rate limit: 10 sign-ins/min per client IP;
  the IP comes from the edge's `X-Forwarded-For` (last entry): the edge must set it.

### `/api/baskule`

JSON except for raw audio uploads. `GET/PATCH /admin/settings` requires `transcription {enabled, providerId, baseUrl, model}`
and accepts write-only `transcriptionApiKey` (empty clears a separate slot). Keys share the chat connection's provider/endpoint slot;
`transcriptionApiKeyConfigured` reports whether that slot has a key. Conflicting keys for one slot return 400.
Clearing a shared slot through `transcriptionApiKey` returns 400 `shared_api_key`; change that key on AI → Models.
Transcription-only changes do not reload spaces unless the shared chat key changes.
A PATCH that changes the AI configuration or its key is refused (`ai_key_missing`, `ai_key_rejected`,
`ai_model_not_found`, `ai_provider_unreachable`, `ai_provider_error`) unless the provider accepts the key and model:
a model lookup for Mistral, OpenAI and Anthropic, one short chat completion for other endpoints. Built-in models take
their price from the presets or models.dev, never from the request. `POST /admin/ai/models` and `POST /admin/ai/verify`
(`{providerId, baseUrl, apiKey?, modelId}`) list a connection's models and run the same check for the admin page; without
`apiKey` they use the key saved for that provider and endpoint.
Transcription accepts WebM, MP4, MP3, Ogg, WAV, M4A, FLAC and AAC audio MIME types. Requests are limited to
one per user and eight globally in flight, and users blocked by usage limits receive 429 before audio is read.

| Method + path | Who | Notes |
|---|---|---|
| `GET /me` | any | `{user{id,name,email,role,canCreateSpaces}, session{id}, organization{id,name}, spaces[{id,name,kind,role,base}], voiceInput}` — `base` = `/s/<id>`, personal first; `voiceInput` requires enabled transcription and a saved key |
| `POST /transcriptions` | any | supported raw audio body, ≤25 MiB; forwards multipart to the configured `/audio/transcriptions` without redirects, with one 120 s deadline covering the upload and the provider; returns `{text}`; 404 disabled, 400 invalid or stalled audio, 413 too large, 429 usage or concurrency limit or provider rate limit, 502 `transcription_key_rejected` when the provider refuses the key, else `transcription_failed` |
| `GET /plugins/:id/connect`, `GET /plugins/oauth/callback` | signed-in user | per-server MCP OAuth or incremental login-identity consent; [installation setup](../docs/installation-settings.md#plugin-account-connections-040) |
| `DELETE /plugins/:id/connection` | signed-in user | forget a connection (optional `?server=NAME`); login account remains linked |
| `PUT /admin/plugins/:id/oauth` | admin | encrypted, write-only pre-registered OAuth client settings |
| `GET /people` | any | `{people[{id,name,email}]}` (active accounts, to add members) |
| `GET /spaces` | any | the caller's spaces |
| `POST /spaces {name, members?[{userId|email, role?}]}` | admin, or a member whose groups grant `canCreateSpaces` | team space; the creator is owner |
| `GET /spaces/:id` | member (admin: team spaces) | `{space, members[{userId,name,email,role}]}`; 404 otherwise |
| `PATCH /spaces/:id {name}` | owner or admin | team only |
| `DELETE /spaces/:id` | team: owner or admin; personal: admin only | wipes the SpaceCell first (`/_baskule/delete`, fails closed with 502); a deleted personal space is replaced by a fresh empty one |
| `POST /spaces/:id/members {userId|email, role?}` | owner or admin | team only |
| `PATCH /spaces/:id/members/:userId {role}` | owner or admin | keeps ≥1 owner; revokes that user's sockets in the space |
| `DELETE /spaces/:id/members/:userId` | owner, admin, or the member themself | revokes at once |
| `POST /invitations {email, role?, spaces?[{spaceId, role?}], expiresInHours?}` | admin | `{id, token, url}`; `url` = `<origin>/invite#token=<token>` (fragment: never sent to a server or in a Referer) |
| `GET /invitations`, `DELETE /invitations/:id` | admin | list (no tokens) / revoke |
| `POST /invitations/lookup {token}` | public | `{email, role, expiresAt, spaces[{id,name,role}]}` or 404 |
| `POST /invitations/accept {token, name, password}` | public | creates the account **with the invitation's email**, adds the memberships, signs in (cookie + `set-auth-token`); single use |
| `GET /admin/users` | admin | `{users[{id,name,email,role,banned,firstSignInAt,activeSessions}]}` |
| `POST /admin/users {email, name, password, role?}` | admin | temporary password |
| `PATCH /admin/users/:id {role?, name?}` | admin | keeps ≥1 admin; a role change revokes the user's sockets |
| `DELETE /admin/users/:id` | admin | wipes the personal space, revokes, deletes |
| `POST /admin/users/:id/deactivate` · `/activate` | admin | Better Auth ban (sessions deleted, sign-in 403) |
| `POST /admin/users/:id/sign-out-everywhere` | admin | |
| `POST /admin/users/:id/password {password}` | admin | **only if the person never signed in** (409 otherwise) |
| `POST /admin/users/:id/reset-link` | admin | `{token, url}` with `url` = `<origin>/reset-password#token=…`; using it revokes **all** the person's sessions |
| `GET /admin/spaces[?status=live]` | admin | every space; team spaces with members, personal spaces with their owner only; `status` = last cached `/_baskule/status` (`null` if never fetched, no cell woken); `?status=live` asks every SpaceCell (3 s timeout each) |
| `GET /admin/spaces/:id/status` | admin | live status of one space (refreshes the cache) |
| `POST /admin/spaces/:id/stop` | admin | stop the space's agent and computer: SpaceCell `POST /_baskule/stop`, then a status refresh; `{ok, status}` or 502 (any space kind: reveals no content) |

Errors: `{error: <code>, message?}` with 400/401/403/404/409/413/502.

## Contract for SpaceCell

Constants and the codec: `src/shared/contract.ts`,
`src/shared/identity.ts` (`identityFromRequest(req)`).

- Requests arrive with the `/s/<spaceId>` prefix stripped, `x-baskule-identity` (base64url JSON
  `{userId,name,email,role,sessionId,spaceRole}`) and `x-baskule-base: /s/<spaceId>`. The Worker removed every inbound
  `x-baskule-*`, the `baskule.*` cookies and `Authorization`, and 404s `/s/*/_baskule/*` (all encodings).
- **Webhooks:** `<origin>/hooks/<spaceId>/<rest>` arrives as `/api/hooks/<rest>` with `x-baskule-webhook: 1`,
  `x-baskule-base`, and **no identity**. T3 must build its webhook URLs as `<origin>/hooks/<spaceId>/<hookId>/<token>`
  and check the token itself. Unknown spaces get 404 in the Worker (no cell is created).
- `POST /_baskule/revoke {userId?|sessionId?}`: close matching sockets (the stub uses close code 4401). It is called
  for member removal, role changes, sign-out, password change/reset, deactivation, sign-out-everywhere and deletion.
  It must be cheap and **must not boot T3** (it can wake a hibernated cell).
- `POST /_baskule/delete`: wipe the space (T3 and OpenCode) and its computer; answer 2xx only when done. ControlCell keeps the rows
  and answers 502 otherwise.
- `GET /_baskule/status` → `{awake, sockets, activeRuns, computer}`: must not boot T3 (the live admin overview calls
  every space).
- `POST /_baskule/stop`: interrupt active runs, ask computerd to stop the computer, let the cell go idle; 2xx when
  done (ControlCell answers the admin 502 otherwise). Called by `POST /api/baskule/admin/spaces/:id/stop`.
- **60 s recheck** (`src/shared/recheck.ts`): while sockets are open, every 60 s call `recheckSockets(env.CONTROL,
  spaceId, sockets)`; it POSTs `http://control/_baskule/check` (`x-baskule-internal: 1`) with
  `{spaceId, sessions[{userId, sessionId}]}` and closes (4401) the sockets whose session is not in `valid` (expired,
  deleted, banned, or no longer a member). The echo stub shows the alarm-based use. The space id is the DO name; the
  stub reads it from `x-baskule-base`.

## Design notes

- **Better Auth 1.7.12** (exact pin) with the Drizzle adapter on DO SQLite (`drizzle-orm/durable-sqlite` 0.45.4),
  `transaction: false` (Drizzle's DO transactions are sync). Passwords: `@noble/hashes` scrypt in Better Auth's format
  (`src/control/password.ts`), because celld lacks `node:crypto` scrypt. Plugins: `admin` (roles `admin` without
  impersonate/set-password/set-email/update, and `member`) and `bearer` (`requireSignature`). No organization plugin
  (review H7): our own `organization` table; one org.
- **Schema**: Better Auth tables generated by `auth generate` (`scripts/auth-gen/auth-cli.ts`) into
  `src/control/schema/auth.ts`; ours in `src/control/schema/app.ts`. Migrations: `pnpm run db:generate` (drizzle-kit,
  `durable-sqlite` driver) into `src/control/migrations/`, plus the custom `0001_personal_space_triggers.sql`
  (a personal space can only ever hold its owner; kind and owner are immutable). Applied in `blockConcurrencyWhile`.
  On every Better Auth upgrade: regenerate the auth schema and diff.
- **ControlCell is the single authority** for every `/s/*` request: one `getSession` + one indexed membership query
  per request/upgrade (no caching anywhere, so revocation is immediate). It is a singleton DO: all authorisation goes
  through one isolate thread (≈ a few ms each). Fine for one organisation; the documented scale-out is a signed
  short-lived identity (Better Auth `jwt` plugin) verified in the Worker.
- **Revocation** is pushed from Better Auth's `session.delete` database hook (sign-out, password change/reset, ban,
  sign-out-everywhere, user deletion) and from our member/role changes; each request waits for its revocation calls
  (5 s timeout) before answering. The 60 s recheck covers expiry and lost pushes.
- **#258**: ControlCell only makes outbound calls inside the request that causes them (no long-lived continuations),
  so it needs no keepalive.
- `src/dev/stub-cells.ts`: isolated echo SpaceCell for the Worker integration test (`test/integration/entry.ts`);
  a test fixture, not a production implementation.

## Fake LLM (`dev/fake-llm/server.mjs`)

OpenAI-compatible `POST /v1/chat/completions` (SSE when `stream: true`, `stream_options.include_usage`), `GET
/v1/models`, `GET /_fake/requests` (last 50 bodies), `POST /_fake/reset`. Deterministic. Markers in the last user
message (or the system prompt): `[[fake:text …]]`, `[[fake:long N]]`, `[[fake:tool NAME {json}]]` (repeat for a
sequence; step = number of tool results since the last user message; then answers `Done: name=result…`),
`[[fake:reasoning …]]`, `[[fake:delay ms]]`, `[[fake:error status]]`, `[[fake:describe]]`. Accepts `image_url`,
`file`/`input_file` (data URLs, e.g. PDF) and `input_audio` parts and summarises them (`[attachments: image/png x1,
application/pdf x1]`). `FAKE_LLM_KEY` makes it require a bearer key.
