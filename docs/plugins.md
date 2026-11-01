# Plugins from a folder

An administrator can manage plugin definitions as standard files next to the released
`docker-compose.yml`. Mount one folder read-only on `baskule-deploy`:

```yaml
services:
  baskule-deploy:
    volumes:
      - ./plugins:/plugins:ro
```

The mounted tree accepts three kinds of entries:

```text
plugins/
  plugins/acme-sales/       # Standard plugin package, like a ZIP upload
    .claude-plugin/plugin.json
    .mcp.json
    skills/sales/SKILL.md
  skills/brand-voice/       # Standard Agent Skill, including supporting files
    SKILL.md
  mcp/internal-crm.json     # Standard mcpServers or VS Code servers JSON
```

Packages can use `.codex-plugin/plugin.json` instead of the Claude manifest. No
Baskule-specific file or field is required. The same package inspector, remote-server
rules and size limits used for uploads apply. Local programs and unsupported files
are reported rather than run. Symlinks are rejected.

Run `docker compose up -d` after editing the tree, or restart the stack. Compose
reruns the completed one-shot deploy job. Restarting only a platform node does not
run startup jobs; restart `baskule-deploy` as well. There is no live watcher.
Definitions are reconciled together in one sync.

New entries appear under Admin → Plugins, assigned to nobody. Configure keys,
vendor sign-in, groups, tool switches and Pause in the UI. Use `${VARIABLE}` in
standard MCP headers for keys that need setup; no environment expansion is performed.
Imported header values never become part of the public definition. Enter keys in the
UI, where they are encrypted in the database. Export remains available.

Adding or editing an entry changes its definition on the next sync. Its relative path
is its identity: `plugins/acme-sales`, `skills/brand-voice`, or
`mcp/internal-crm.json`. UI configuration survives updates at the same path, including
server switches and keys associated with the same server name. For a retained server
name, saved keys and accounts continue to be used if its address changes; the
administrator editing the mounted files controls those addresses. Removing an entry
removes its plugin and stored configuration. Renaming a path removes the old plugin
and adds an unassigned plugin. Definitions and deletion are locked in the UI.

Invalid entries do not prevent other entries from syncing or the stack from starting.
Admin plugin responses include the last sync time and per-path problems. An invalid
update keeps the last valid definition until it is corrected or removed. An unreadable
inventory or failed sync request fails the startup job instead of treating the mount
as empty. In Compose, the edge waits for the deploy job to succeed, so an inventory
or sync failure also prevents the web entry point from starting.

Without a mount, folder sync is off, the API reports `folder: null`, and existing
folder plugins stay in the database. To deliberately remove all folder plugins, sync
an empty mounted directory first. Removing the mount alone does not delete them.

The deploy job uses the existing installation token (`COMPUTERD_TOKEN`) to call the
Worker over the installation's private network. Do not expose that token in plugin
files. For cluster deploy jobs, mount the tree on the one host that performs deployment
and set `PLUGIN_SYNC_URL` to a reachable platform Worker address.

For local development, `scripts/stack` reads `.run/plugins` on celld startup and
restart. Set `BASKULE_PLUGINS_DIR` to use a different directory. Use the fake model
and `scripts/stack restart celld` to exercise changes.
