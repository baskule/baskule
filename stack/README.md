# Worktree app stack

Run `scripts/worktree setup` to prepare the pinned toolchain and dependencies. `up` and `reload` use that
same command to refresh dependencies and the embedded bundle, with unchanged inputs skipped.
Stacks run as root on the development host, using its single portless proxy. The rootless GitHub runner cannot
register routes with that proxy; run `features` locally in a T3 worktree (the other remote loops are unchanged).
Install `portless` globally and `libnss3-tools` on the host. Profiles with computers also require the existing
OpenShell gateway and computer images.

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
`${BASKULE_SHARED:-/srv/baskule}`. `BASKULE_MAX_STACKS` defaults to six; capacity reservations include stacks
still building. A killed startup is reclaimed by `gc` or the next `up`.

`full` is the default, `light` omits computers and the gateway, and `rustfs` runs production-mode celld against
the shared development RustFS bucket with an instance-specific prefix. Shared services stay up after `down`. The development gateway uses 127.0.0.1:47510 and its volume helper
uses 127.0.0.1:47511; rootless CI gateway loops use 47520/47521.
Node clients of the HTTPS front use `NODE_EXTRA_CA_CERTS=~/.portless/ca.pem`; `portless trust` installs the CA
for curl. Stack startup also imports the CA idempotently into Chromium's NSS shared database, choosing
`~/.pki/nssdb` when it exists, otherwise `${XDG_DATA_HOME:-~/.local/share}/pki/nssdb` (Chrome M146+). `portless list` shows the host proxy routes.

## Profiles

Add `stack/profiles/<name>.json`; no tool change is needed. A profile has `mode` (`dev` or `rustfs`),
`shared` (`gateway`, `rustfs`), `env` overrides and an ordered `services` object. `celld` is required and uses
the tool's build/runtime command. Other services declare `command`, `args`, optional `cwd`, `env`, and an
HTTP `health` URL. Every service receives a kernel-allocated port as `PORT_<UPPERCASE_NAME>` (hyphens become
underscores). Strings can reference `${ROOT}`, `${RUN}`, `${LOOPBACK_URL}`, `${STACK_URL}`, ports and environment
variables. For example, clone `light.json`, add an environment value, and run `up --profile your-feature`.
`--set K=V` overrides profile environment values for that stack run (manual custom provider checks can set
`LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`); `reload` and service restarts retain them.
`restart celld` restarts without rebuilding, for persistence checks.

The web cache hashes tracked and untracked app inputs by content, including dirty edits. Failed builds never
publish cache entries. Cache entries are immutable and shared; `gc` reclaims entries unused for seven days. Other component loops retain their existing launchers and fixed ports for now; they
share the renamed `osdev-openshell` gateway and retain their existing loop locks. Worktree stacks lock only
capacity reservation and shared infrastructure startup, so feature checks can overlap. The legacy agent and
computerd loops use `loop-agent` and `loop-computerd` instance labels; they cannot adopt a stack's computers.
