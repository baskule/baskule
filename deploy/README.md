# Baskule deployment (single node, Docker Compose)

> Retired Alpha 0.1 deployment. Its computerd source was removed on 2026-10-26; these instructions no longer build. Use [deploy/v2](v2/README.md) for the current stack.

Architecture D11. Three services on network `baskule-net`:

| Service | Image | Role | Published |
|---|---|---|---|
| `baskule-server` | `baskule-server:0.1` (`server.Dockerfile`, built from `../app`) | T3 fork: web UI, chats/history (SQLite), file preview | `${BASKULE_BIND}:47080` → 3773 |
| `baskule-computerd` | `baskule-computerd:0.1` (`../computerd`) | wake-on-request OpenCode proxy, idle sleep, Docker socket | no |
| `baskule-computer-default` | `baskule-computer:0.1` (`../computer`) | OpenCode 2 + tools + Chromium; sleeps when idle | no |

Volumes: `baskule-server-data` (`/baskule` in the server: `userdata/` = settings, secrets, SQLite),
`baskule-chats` (`/baskule/scratch` in server **and** computer, same path), `baskule-attachments`
(`/baskule/userdata/attachments`: chat uploads, read-only in the computer at the same path, because T3 only passes an
upload's path to a remote OpenCode), `baskule-computer-data` (`/data` in the computer: HOME + OpenCode state).
Both images run as UID 1000.

Lifecycle of the computer: `compose up` creates **and starts** it; computerd adopts it as `awake` and stops it after
`BASKULE_IDLE_MINUTES` with no request and no active OpenCode session. Any OpenCode request (a chat message, T3's
probes) then wakes it with `docker start` (~2 s). It has `restart: "no"`: after a host reboot it stays stopped until the
first request.

## Configure

```sh
cd baskule/deploy
cp .env.example .env        # gitignored; holds the LLM key
$EDITOR .env                # BASKULE_LLM_*, BASKULE_OPENCODE_PASSWORD (openssl rand -hex 24), BASKULE_BIND
```

`BASKULE_BIND=<your private interface IP>` for remote use. There is **no auth** (`BASKULE_AUTH_MODE=none`): never bind
to a public address.

## Build, start, stop, logs

```sh
# if buildx cannot write ~/.docker: export DOCKER_CONFIG=/tmp/baskule-deploy-dockercfg
docker compose build                 # server build ~5 min uncached (pnpm install + web/server build)
docker compose up -d --wait          # http://<BASKULE_BIND>:47080
docker compose ps
docker compose logs -f baskule-server baskule-computerd
docker compose exec baskule-computerd wget -qO- http://127.0.0.1:4096/_computerd/status   # asleep/awake/...
docker compose exec baskule-computerd wget -qO- --post-data= 'http://127.0.0.1:4096/_computerd/sleep?force=1'
docker compose stop                  # keeps containers + volumes
docker compose down                  # removes containers, keeps volumes (= all data)
# docker compose down -v             # DELETES all chats, history and the computer's disk
```

The server image builds from the fork's **working tree** (`../app`, without `node_modules`/`dist`). To build a
specific commit, export it and point `BASKULE_APP_CONTEXT` at it (absolute `BASKULE_SERVER_DOCKERFILE` then):

```sh
git -C ../app archive baskule/main | tar -x -C /tmp/baskule-app
BASKULE_APP_CONTEXT=/tmp/baskule-app BASKULE_SERVER_DOCKERFILE=$PWD/server.Dockerfile docker compose build baskule-server
```

## Model swap

Edit `BASKULE_LLM_BASE_URL` / `BASKULE_LLM_API_KEY` / `BASKULE_LLM_MODEL` / `BASKULE_LLM_MODEL_SETTINGS` in `.env`,
then recreate both consumers:

```sh
docker compose up -d --force-recreate baskule-server baskule-computer-default
```

- The computer regenerates `opencode.jsonc` (provider `llm`) at every start.
- The server entrypoint re-renders the Baskule-managed keys of `/baskule/userdata/settings.json` at every start
  (`render-settings.mjs`): non-OpenCode providers disabled, `opencode` → `http://baskule-computerd:4096` + password,
  `defaultModelSelection` and `textGenerationModelSelection` = `opencode` / `llm/<BASKULE_LLM_MODEL>`. All other
  settings are preserved. T3 moves the password into `userdata/secrets/` on load.
- Existing chats keep the model they were created with.

`--force-recreate` on the computer starts it (computerd then puts it back to sleep when idle). Changing
`BASKULE_OPENCODE_PASSWORD` needs all three services recreated: `docker compose up -d --force-recreate`.

## Upgrade

```sh
git -C ../app pull   # or merge upstream on baskule/main (see app/BASKULE.md)
docker compose build && docker compose up -d --wait
```

- **Redeploying the server interrupts in-flight agent runs**: on shutdown T3 interrupts running turns on external
  OpenCode servers. Wait until no chat is running. Chats and history are kept.
- Recreating the computer loses anything installed with `apt-get` (container layer); `/data` (HOME, pip venv,
  npm/bun globals, OpenCode DB) and the chats survive.
- Recreating computerd is harmless: T3's held event streams reconnect.
- Volumes are never touched by `up`/`build`. Back up with `docker run --rm -v baskule-server-data:/v -v $PWD:/b
  debian tar czf /b/server-data.tgz -C /v .` (same for `baskule-chats`, `baskule-attachments`, `baskule-computer-data`).

## Test

Alpha 0.1 is retired; its stack smoke test (`e2e/smoke.sh`) was removed on 2026-10-23 (see Git history).

## Files

| File | |
|---|---|
| `docker-compose.yml` | the stack (project `baskule`; `BASKULE_INSTANCE` prefixes container/volume/network names) |
| `server.Dockerfile` (+ `.dockerignore`) | multi-stage: Node 26.12.1 + pnpm 12.14.0 (installed with npm) build (node-pty native) → `node:26.12.1-trixie-slim`, UID 1000 |
| `server-entrypoint.sh` | refuses a base dir inside a git work tree, renders settings, runs `t3 serve --host 0.0.0.0 --port 3773 --base-dir /baskule` from `/baskule/scratch` |
| `render-settings.mjs` | settings renderer (see Model swap) |
| `.env.example` | documented config |
