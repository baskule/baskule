---
paths: ["platform/src/control/**", "platform/src/agent/**", "app/apps/web/src/baskule/plugins/**", "app/apps/web/src/baskule/admin/plugins/**", "app/apps/web/src/routes/_chat.settings.plugins.tsx", "app/apps/web/baskule-dev/mock-plugins.mjs", "app/apps/web/baskule-dev/plugin-catalog.json", "app/apps/mobile/src/baskule/settings-api.ts", "e2e/journeys/plugins.spec.mjs"]
journeys: "@feature:plugins"
profile: "full"
checks: ["scripts/check worker space agent web"]
---
# Plugins: catalog, install, runtime and connections

## Sub-features

Catalog from the Cursor and xAI registries and connected app platforms (Composio, Pipedream), review before adding, GitHub and MCP-server imports, access per plugin (everyone or groups), admin-filled variables, one OAuth client per authorization server, runtime tools, the member's switch, per-server sign-in.

## Open the feature

Administrators add plugins under Admin → Plugins → Browse (or "+" for GitHub and MCP servers), choose who can use each one on its page, and finish setup there or under Sign-in & sources. Members open Settings → Plugins to switch plugins on or off and sign in to each server. Mobile opens the web page to sign in.

## Verification

Run `scripts/check feature:plugins`. The MCP-server journey adds a fake MCP server by address through the UI, checks a member's tool call reaches it, then switches the plugin off for that member and checks no further call reaches the server. The OAuth-client journey adds a fake OAuth server that refuses dynamic registration: the review page shows the sign-in setup with the callback URL first, the member sees "Not ready yet" until the admin saves the client, then signs in through the fake provider; an unconnected member makes no vendor call, the connected member's call uses their own identity, and Disconnect returns to Sign in. Platform unit tests cover catalog parsing, auth probing, setup, runtime policy and the hosted platforms; worker covers install and OAuth sign-in on celld; space and agent cover delivery.

For screenshots without the platform, run `app/apps/web/baskule-dev/check.sh plugins` (mock catalog recorded from the real registries; see its README).

## Gotchas

Use fake LLM markers from `platform/dev/fake-llm/server.mjs`. Use disposable accounts, spaces, and computers created for the check. If a port is busy, identify the process using it; never stop another run or worktree to free it.
