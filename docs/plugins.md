# Plugins

A plugin gives the assistant remote MCP servers (shown as **apps**) and skills. Administrators install plugins
under **Admin → Plugins**; nothing is installed by default. Members sign in to a plugin's apps and switch
plugins on or off for themselves in **Settings → Plugins**.

## Sources

- **Catalog.** Four registries read hourly from GitHub: Anthropic's official directory
  (`github.com/anthropics/claude-plugins-official`) and knowledge-work role packs
  (`github.com/anthropics/knowledge-work-plugins`), Cursor (`github.com/cursor/plugins`) and xAI
  (`github.com/xai-org/plugin-marketplace`). A brand listed by several registries appears once. Only plugins
  that install completely are listed; from Anthropic's official directory only plugins with apps, since its
  skill-only plugins are Claude Code developer tools. Plugins pinned to a vendor's own repository are listed
  from their manifest and MCP configuration, so a refresh does not use GitHub's API for each one. Logos and installs are
  pinned to the commit that was read. **Refresh** reads the registries again; a registry that cannot be read
  keeps its previous listing and is reported.
- **From GitHub.** Any public `github.com` repository or folder, for example
  `https://github.com/owner/repo/tree/main/plugins/notes`. Baskule reads `plugin.json`,
  `.cursor-plugin/`, `.grok-plugin/`, `.claude-plugin/` or `.codex-plugin/` manifests, `mcp.json`,
  `skills/*/SKILL.md` with text companions, and `agents/*.md` and `commands/*.md` as skills.
- **MCP server.** An address you enter, with no sign-in, member sign-in (OAuth) or an organization header such
  as `Authorization` or `X-API-Key`. Only these servers may use private addresses.
- **Composio and Pipedream.** Their app lists join the catalog once you add their credentials (see below).

Local programs (`command` servers), editor-only parts (`hooks/`, `rules/`, `automations/`, `.lsp.json`) and
servers that only work inside the catalog vendor's own app are never installed; the plugin page lists them under
**Not added**. Repository code is never run.

## Installing

Opening a plugin previews the exact content that will be installed: its apps with their address and how members
sign in, the values it needs, and its skills. When a plugin has several apps, switch off the ones your team does
not use before adding it; role packs list alternatives such as several CRMs. Apps the publisher left without an
address are listed under **Not added**. Installing fetches the same commit again and refuses with
`plugin_changed` if the content differs from the preview.

- **Who can use it**: Everyone, or chosen groups. Changing access, pausing or removing applies to running spaces
  at once.
- **Values**: a `${NAME}` placeholder in a server address or header becomes a field to fill in, for example
  NetSuite's account address or a GitHub token. Values are encrypted and never shown again; header values are
  treated as secrets. An app stays **Needs setup** until its values are saved. A new address signs members out
  of that app.
- **Status**: **Ready**, **Needs setup** (values, a sign-in client or a provider are missing) or **Paused**.
  Members cannot use a plugin until it is ready.

## Sign-in setup

How members sign in is detected when you preview a plugin:

- **No sign-in** or an **organization header**: members have nothing to do.
- **Member sign-in with dynamic registration**: Baskule registers itself with the vendor when a member first
  signs in. Nothing to set up.
- **Needs an OAuth client**: the vendor (Google, for example) requires a client you register once. One client
  per authorization server serves every plugin that uses it: a Google client covers Gmail, Drive and Calendar.

The callback URL to register is `https://<your Baskule address>/api/baskule/plugins/oauth/callback`; the
**Sign-in and sources** page shows it with a copy button.

### Google

1. In the [Google Cloud console](https://console.cloud.google.com/), choose or create a project.
2. Enable the API of each host listed for the Google client, for example for Gmail:
   `gcloud services enable gmailmcp.googleapis.com gmail.googleapis.com`. Each Google MCP server is a separate
   service; enable it next to its product's API.
3. Configure the OAuth consent screen (Google Auth platform → Branding and Audience):
   - **Internal**: only accounts of your Google Workspace organization can sign in, with no app review. Use this
     when every member has a Workspace account in that organization.
   - **External**: any Google account. While the app is in *Testing*, only listed test users can sign in and
     their sign-ins expire after seven days. Publishing an app that requests Gmail or Drive scopes requires
     Google's verification.
4. Create an OAuth client ID of type **Web application** with the callback URL above as an authorized redirect
   URI.
5. In Baskule, save the client ID and secret for `https://accounts.google.com`. Leave **Scopes** empty to
   request what each server advertises. **Authorization parameters** default to
   `access_type=offline&prompt=consent`, which Google needs to issue refresh tokens.

Saving a different client ID signs members out of every app that used the previous one; rotating only the
secret keeps their sign-ins. Removing a client puts those apps back into **Needs setup**.

## Composio and Pipedream

Both platforms host the vendors' sign-in and hold the members' tokens. Add their credentials under
**Admin → Plugins → Sign-in and sources**; Baskule checks them with the platform before storing them encrypted.

- **Composio**: a project API key. The catalog lists the toolkits Composio can sign members in to, plus those your
  project has an enabled auth config for. A toolkit's tools reach the assistant through Composio's tool router
  (search, then run tools), pinned to the member's own account.
- **Pipedream**: a Pipedream Connect project: OAuth client ID and secret, project ID and environment. Members
  connect on Pipedream's hosted page; the assistant uses Pipedream's remote MCP server for that app and account.
  Changing the project or environment signs members out of Pipedream plugins.

Members appear to these platforms under a pseudonymous ID derived from the installation secret, not their email.
Removing a platform's credentials puts its plugins into **Needs setup**; removing a plugin disconnects its
members' accounts at the platform.

## What members can do

In **Settings → Plugins** members see the plugins they may use. For each plugin they can switch it off or on
for themselves, and for each app sign in (one account per app), sign in again after a sign-in expired, or
disconnect. An app that is not ready reads "Not ready yet, ask an administrator".

Tool calls always use the turn author's own sign-in, also in team spaces and for scheduled tasks. A refresh
token survives a vendor outage; only a refused grant ends the sign-in.

## Network and storage

Plugin requests leave from celld, not from computers, so computer egress rules do not apply to them. Outbound
plugin, sign-in and catalog requests use HTTPS to public addresses (an administrator's MCP server may use a
private one), never follow redirects, and keep MCP traffic on the server's origin. These checks inspect URLs, not
DNS answers: deployment egress rules must deny private destinations for public names. Values, client secrets,
provider credentials, tokens and pending sign-ins are encrypted with keys derived from the installation secret.

Upgrading from the earlier plugin system removes every installed plugin, connection and plugin setting. A
`./plugins` mount and the `PLUGIN_SYNC_TOKEN` secret are no longer used and can be deleted.
