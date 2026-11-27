# OpenCode 2

Baskule runs OpenCode 2 only. Its SpaceCell deployment embeds OpenCode 2.1.3. To run a local instance, install `@opencode/cli` 2.x on the machine running the environment, authenticate with `opencode auth login`, and configure it in **Settings > Providers**.

Models from other vendors are selected through OpenCode; they do not require a separate agent harness. Multiple OpenCode instances can use different servers, credentials, and model catalogs.

## Compaction

OpenCode compacts long conversations itself, and T3 Code has no setting for it. On
OpenCode 2, change it under `compaction` in an OpenCode configuration file, such as
`opencode.json`: `auto` turns
automatic compaction on or off, `buffer` sets the token headroom, and `keep.tokens`
sets how much recent context stays. OpenCode 1.x configures compaction differently.
Send `/compact` to compact a thread yourself.

## Local or external server

- **Managed local server** (default): Leave **Server URL** empty. Uses your configured password, `OPENCODE_SERVER_PASSWORD`, or a generated password.
- **External server**: Set **Server URL** and password in provider settings (does not forward local `OPENCODE_SERVER_PASSWORD`).
- **Updating a local service**: When **Server URL** points to a local OpenCode background service (using its exact host/port—`127.0.0.1` for `0.0.0.0`, `[::1]` for `[::]`, not `localhost`), T3 Code upgrades the CLI and restarts the service (interrupting active turns; configure service env vars with `opencode service set env <name> <value>`). Other external servers must be restarted manually.

## Compaction, approvals, and catalog refresh

- **Compaction**: Send `/compact` manually, or configure `compaction` (`auto`, `buffer`, `keep.tokens`) in `opencode.json` on OpenCode 2.
- **Approvals**: Follows [permission modes](./permission-modes.md); **Auto** behaves like **Supervised**. Reading `.env` / `.env.local` asks for approval in restricted modes (`.env.example` is allowed). **Allow for workspace** applies across all OpenCode sessions sharing that workspace—use **Allow once** on shared servers.
- **Refreshing config**: Click **Refresh provider status** (web/desktop) or **Refresh models** (mobile) after auth/config changes. Local helper caches clear after 30 seconds of inactivity; external servers may need a restart. Project-specific models in `opencode.json` load when opening that project's model picker.
