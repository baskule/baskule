# Worktree app stack

Run `scripts/worktree setup` to prepare the pinned toolchain and dependencies. `up` and `reload` use that
same command to refresh dependencies and the embedded bundle, with unchanged inputs skipped.
The optional HTTPS proxy runs when root and a globally installed `portless` are available;
it also requires `libnss3-tools` for Chromium certificate trust. When root or Portless is
unavailable, startup prints one notice and uses direct loopback HTTP. `BASKULE_STACK_PROXY=0` disables the proxy; `1` requires it.
Profiles with computers require Docker socket access and local `baskule-computerd:local` (guard)
and `baskule-computer:local` images. Build them with `deploy/build.sh --no-deploy` before
`--profile full` or `scripts/check agent`, `computerd`, or `features`.

```sh
scripts/stack up                         # real hosted app, fake model, real computers
scripts/stack doctor                     # read-only service, port, front and admin checks
scripts/stack status --json              # ports, URLs, credentials, PIDs and logs
scripts/stack logs celld
scripts/stack reload                     # rebuild app, keep cell state
scripts/stack down                       # stop this stack; keep state and shared infrastructure
scripts/stack down --purge               # also delete this stack's local state and computer volumes
scripts/stack gc                         # reclaim abandoned stacks
scripts/check features                  # full profile, clean state, feature checks, purge
```

Use a distinct branch per worktree. The branch slug forms the portless alias
`https://<slug>.baskule.localhost`. Resource instance IDs append a stable worktree-path hash to the slug,
so stopped stacks with colliding branch slugs cannot delete each other's retained data. A running alias
collision is refused. Generated credentials and state live in `.run/stack/stack.json`
(mode 0600); consumers read this file rather than guessing ports. The registry and build cache live under
the parent of `.tools`, or `${XDG_CACHE_HOME:-~/.cache}/baskule` when `.tools` is absent.
`BASKULE_SHARED` overrides this location. `BASKULE_MAX_STACKS` defaults to six; capacity reservations include stacks
still building. A killed startup is reclaimed by `gc` or the next `up`.

`full` is the default, `light` omits computers, and `rustfs` runs production-mode celld against
the shared development RustFS bucket with an instance-specific prefix. Full stacks use the Docker backend and a worktree-scoped computer bridge.
The guard requires Docker's iptables DOCKER-USER chain and a helper with host NET_ADMIN. Docker access grants host administration privileges. `--set COMPUTER_GUARD_IMAGE=...`
and `--set COMPUTER_IMAGE=...` select locally available images; `COMPUTER_DNS` accepts public DNS IPs.
`down` stops owned computers and retains disks; `down --purge` deletes owned containers and disks.
Node clients of the HTTPS front use `NODE_EXTRA_CA_CERTS=~/.portless/ca.pem`; `portless trust` installs the CA
for curl. Stack startup also imports the CA idempotently into Chromium's NSS shared database, choosing
`~/.pki/nssdb` when it exists, otherwise `${XDG_DATA_HOME:-~/.local/share}/pki/nssdb` (Chrome M146+). `portless list` shows the host proxy routes.

## Profiles

Add `stack/profiles/<name>.json`; no tool change is needed. A profile has `mode` (`dev` or `rustfs`),
`shared` (`rustfs`), `env` overrides and an ordered `services` object. `celld` is required and uses
the tool's build/runtime command. Other services declare `command`, `args`, optional `cwd`, `env`, and an
HTTP `health` URL. Every service receives a kernel-allocated port as `PORT_<UPPERCASE_NAME>` (hyphens become
underscores). Strings can reference `${ROOT}`, `${RUN}`, `${LOOPBACK_URL}`, `${STACK_URL}`, ports and environment
variables. For example, clone `light.json`, add an environment value, and run `up --profile your-feature`.
`--set K=V` overrides profile environment values for that stack run (manual custom provider checks can set
`LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`); `reload` and service restarts retain them.
`restart celld` restarts without rebuilding, for persistence checks.

The web cache hashes tracked and untracked app inputs by content, including dirty edits. Failed builds never
publish cache entries. Cache entries are immutable and shared; `gc` reclaims entries unused for seven days. Component loops use fixed ports,
Docker computers and their own loop locks. Worktree stacks lock only
capacity reservation and shared infrastructure startup, so feature checks can overlap. The agent and
computerd loops use `loop-agent` and `loop-computerd` instance labels; they cannot adopt a stack's computers.
