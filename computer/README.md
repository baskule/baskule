# baskule-computer — the agent's computer

Docker image `baskule-computer:0.1`. It is the Linux machine an Baskule agent works on: one container (plus volumes) runs
an **OpenCode 2.1.2 server** (`opencode serve --service`) together with a shell, Python, Node, Bun, and headless
Chromium driven by **Playwright MCP**. Each chat is an OpenCode session working in its own directory under the chats
root. See [building from source](../docs/building.md) for the current build instructions.

## Contents

| | |
|---|---|
| Base | `debian:trixie-slim`, `tini` as PID 1, user `agent` (UID/GID 1000, passwordless sudo) |
| Tools | bash, coreutils, curl, wget, git, jq, ripgrep, zip/unzip, xz, make, ssh client, Python 3.13 + pip + venv, Node 24.22.1 (LTS) + npm, Bun 1.3.14, Chromium 155, fonts (Liberation, DejaVu, Noto Color Emoji), locales en_US/fr_FR |
| OpenCode | `@opencode/cli@2.1.2`: single binary `/opt/opencode/bin/opencode` (amd64 uses the *baseline* build: no AVX2 needed) |
| Browser | `@playwright/mcp@0.0.83` pre-installed in `/opt/playwright-mcp`, run with `/usr/bin/chromium --headless --isolated --no-sandbox` |
| Files | `Dockerfile`, `entrypoint.sh`, `gen-config.mjs` + `opencode.template.jsonc` (config generator), `assistant-prompt.md` (agent system prompt), `healthcheck.sh` |

Versions are build ARGs (`OPENCODE_VERSION`, `PLAYWRIGHT_MCP_VERSION`, `NODE_VERSION`, `BUN_VERSION`), e.g.
`docker build --build-arg OPENCODE_VERSION=2.0.32 -t baskule-computer:0.1 computer/`.

## Volumes and layout

| Path | What | Volume |
|---|---|---|
| `/data/home` | `HOME`. npm prefix `~/.local`, Bun `~/.bun`, default Python venv `~/.venv` (on `PATH`, so `pip install x` persists) | `/data`: private to the computer |
| `/data/opencode/{config,data,state,cache}` | OpenCode `XDG_*` dirs: generated `opencode.jsonc`, `service.json`, SQLite DB, logs | `/data` |
| `/baskule/scratch` (`BASKULE_CHATS_DIR`) | chat directories (`<root>/<chat>`); shared with `baskule-server` at the same path | separate shared volume |

The entrypoint starts as root only to ensure `/data`, `/data/home` and the chats root are owned by UID 1000, then drops
to `agent` (`setpriv`). It initialises everything idempotently, so an empty volume works on first boot and later boots
reuse the state. `apt-get install` goes to the container layer: it survives stop/start but not a container recreate.

## Environment

| Var | Required | Meaning |
|---|---|---|
| `BASKULE_OPENCODE_PASSWORD` | yes | HTTP Basic password for the OpenCode API (user `opencode`). Written to `service.json` with `opencode service set password` at every start (service mode ignores env passwords) |
| `BASKULE_LLM_BASE_URL` | yes | OpenAI-compatible base URL (chat completions), e.g. `https://api.openai.com/v1` |
| `BASKULE_LLM_API_KEY` | yes | API key. Read by OpenCode from the env at runtime, never written to the config |
| `BASKULE_LLM_MODEL` | yes | model id, e.g. `gpt-6-luna` (OpenCode ref `llm/<model>`) |
| `BASKULE_LLM_MODEL_SETTINGS` | no | JSON object of per-model settings, e.g. `{"reasoningEffort":"none"}` |
| `BASKULE_LLM_COST_INPUT`, `_OUTPUT`, `_CACHE_READ`, `_CACHE_WRITE` | no | USD per million tokens, for OpenCode's cost accounting (set cache prices, otherwise costs are under-counted) |
| `BASKULE_LLM_CONTEXT_LIMIT`, `BASKULE_LLM_OUTPUT_LIMIT` | no | token limits (OpenCode defaults: 200k / 32k) |
| `BASKULE_LLM_PROVIDER_NAME` | no | display name of the provider |
| `BASKULE_CHATS_DIR` | no | chats root, default `/baskule/scratch` |
| `BASKULE_OPENCODE_PORT` | no | default `4096` |
| `BASKULE_LOG_LEVEL` | no | OpenCode log level, default `warn` |

Fixed in the image: `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_FREE_MODELS=1`.

The generated config (`/data/opencode/config/opencode/opencode.jsonc`) contains: one provider `llm` using
`@opencode/ai/providers/openai-compatible`; `default_agent: assistant` (custom primary agent with the prompt from
`assistant-prompt.md`); the built-in `build` and `plan` agents get the same prompt (T3 switches to them; plan mode
keeps its read-only permissions and reminders); `policies` that deny every provider except `llm` (so the catalog only
lists the `.env` model, verified by `test.sh`); `plugins: ["-opencode.browser"]` (removes OpenCode's built-in
`browser` tools, which drive the OpenCode desktop app's browser and fail here with "no desktop browser is connected";
found by the E2E suite, S3); permissions allow-all; MCP server `playwright`; `update: disable`,
`share: disabled`. It is overwritten at each start, so change env vars, not the file.

## Model swap

Edit the env (`.env` in deploy) and restart the computer (`docker restart` or computerd sleep/wake). Existing sessions
keep the model they were created with.

Dev default (OpenAI):

```
BASKULE_LLM_BASE_URL=https://api.openai.com/v1
BASKULE_LLM_MODEL=gpt-6-luna
BASKULE_LLM_MODEL_SETTINGS={"reasoningEffort":"none"}   # required: gpt-6-luna rejects tools with reasoning on chat completions
BASKULE_LLM_COST_INPUT=0.10
BASKULE_LLM_COST_OUTPUT=0.50
BASKULE_LLM_COST_CACHE_READ=0.01                       # estimate
BASKULE_LLM_COST_CACHE_WRITE=0.10
```

Mistral (OpenAI-compatible chat completions endpoint; untested here):

```
BASKULE_LLM_BASE_URL=https://api.mistral.ai/v1
BASKULE_LLM_API_KEY=<mistral key>
BASKULE_LLM_MODEL=mistral-medium-latest
BASKULE_LLM_MODEL_SETTINGS={}
BASKULE_LLM_COST_INPUT=0.4
BASKULE_LLM_COST_OUTPUT=2
```

## Build, run, test

```bash
docker build -t baskule-computer:0.1 computer/
# (if ~/.docker is not writable: DOCKER_CONFIG=/tmp/baskule-dockercfg docker build ...)

docker volume create baskule-computer-default-data
docker volume create baskule-scratch
docker run -d --name baskule-computer-default --shm-size=1g --cpus=2 --memory=4g \
  -v baskule-computer-default-data:/data -v baskule-scratch:/baskule/scratch \
  -p 127.0.0.1:47210:4096 --env-file computer.env baskule-computer:0.1

curl -u opencode:$BASKULE_OPENCODE_PASSWORD http://127.0.0.1:47210/api/info
curl -u opencode:$PW -H 'content-type: application/json' \
  -d '{"location":{"directory":"/baskule/scratch/chat-1"}}' http://127.0.0.1:47210/api/session   # dir must exist
```

Give the container `--shm-size=1g` (Chromium). Health: Docker `HEALTHCHECK` calls `/api/info` with auth (1 s probes
during start-up, then every 15 s); `docker inspect -f '{{.State.Health.Status}}'`.

Alpha 0.1 is retired: its image test (`test.sh`) was removed on 2026-10-23 (see Git history). The active image is `v2/`.

Measured on a loaded Celeron N5105 host: image 1.46 GB; build about 2.5 min uncached; cold first boot on empty
volumes → healthy about 5–6 s (includes venv creation and 50 DB migrations); `docker stop` about 1.5 s; `docker start`
→ healthy about 1.4–1.6 s (2026-10-22 re-run with the host at load 12: cold 12.1 s, stop 1.4 s, start → healthy
3.0 s, start → non-empty `agent.list` 4.5 s, which is close to T3's 5 s budget on a loaded host); prompt 1 (shell) 5 s, prompt 2 (browser via Code Mode `execute` → Playwright MCP) 9 s.

## Notes

- Sleep and running work: computerd does not sleep the computer while an execution is active (including an unanswered
  `question` form, which keeps it awake indefinitely) or while any shell command (e.g. a background job) runs in a loaded
  location. Background shell jobs therefore survive idle periods. A job that runs forever keeps the computer awake.

- Playwright MCP writes page snapshots to `.playwright-mcp/` inside the chat directory (hidden dir; the UI may want
  to hide dot-dirs).
- MCP tools are only reachable through OpenCode Code Mode (`execute`); gpt-6-luna handles this fine.
- The agent's shell sees the LLM API key in its environment (OpenCode needs it). The API password is removed from the
  server's environment after it is stored in `service.json` (mode 600). An LLM proxy in the control plane is the later fix.
