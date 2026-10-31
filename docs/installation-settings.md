# Installation and organization settings

The installer owns authentication and infrastructure. An organization administrator owns product settings in
the admin area: **Admin → General → Organization** (organization name, computer idle timeout) and **Admin → AI →
Models** (the AI provider: Mistral, OpenAI, Anthropic, OpenCode (free), or a custom OpenAI-compatible endpoint;
its endpoint and key; the model for chats, chosen from the models the key can use). The installation offers exactly
one provider and model. A change saves only after the provider accepts the key and the model; the ControlCell
checks again before storing it. OpenCode (free) uses DeepSeek V4.1 Flash Free without an API key. Prompts go to
OpenCode's servers under its terms. The model's image/PDF inputs, context window and maximum output in tokens are
prefilled when the provider or models.dev knows them. Set them to the model's actual limits: OpenCode uses them to
decide when to compact context automatically.
People, invitations, roles and space membership are under **Admin → People** and **Admin → Spaces**.
Groups (**Admin → People → Groups**; every person is in the built-in **Everyone**) grant plugins and permissions
such as creating team spaces. Plugins are under **Admin → Plugins**: nothing is installed by default.
An admin adds a plugin from the catalog or from its own address, git commit or file, chooses the groups that may use it, and reviews
what was added. New plugins are unpaused. Assigned skills and tools work after setup, with no
member activation. Administrators can Pause and Resume a plugin. Members see readiness and connect accounts in
**Settings → Plugins**. In a team
space, plugins that act with a member's own account stay off until a space owner allows them in the space settings.

The catalog lists reviewed vendor-hosted services by area, with their prerequisites and instructions. A vendor's
sign-in app is set up once for its plugins. Adding a plugin asks which groups can use it; people then connect
their accounts in Settings → Plugins. Unqualified services show Not available yet. This includes Microsoft
Work IQ until its tenant-specific sign-in and permissions are qualified, as well as Shopify, Figma and Docusign.
Catalog content stays pinned. Use a custom plugin to configure a different server.

The model's prices (USD per million tokens) turn token counts into estimated costs. Built-in providers' prices are
read-only and come from Baskule's presets, then models.dev, or the built-in snapshot when it is unreachable; a custom
endpoint's prices are entered on the Models page. A model without prices records tokens at zero cost. **Admin → AI → Usage & limits** shows usage per person, model and space (each
table exports to CSV) and sets per-person limits: daily, weekly and monthly windows in UTC, each with a token limit,
a cost limit or both, all off by default. Usage counts for the person who sent the message, in any space. Everyone
sees their own usage and limits under **Settings → Usage**; a refused message names the limit and when it resets.

**Admin → AI → Voice input** lets people dictate messages: the microphone left of Send records up to 10 minutes,
stopping appends the transcript to the message, and Send while recording sends the message once the transcript is
in. The default model is OpenAI's GPT Transcribe; any OpenAI-compatible `/audio/transcriptions` endpoint works. Keys
are kept per provider and endpoint, so with OpenAI as the chat provider one key serves both. Browsers give pages the
microphone only over HTTPS or on localhost: on an installation served over plain HTTP, voice input works in the
desktop app only.

Product settings are stored in the existing ControlCell database. The AI key is write-only in the API/UI and is
returned only on the private ControlCell-to-SpaceCell settings call. Keyless providers need no stored key,
report `apiKeyConfigured: true`, and use OpenCode's `public` bearer token. This replaces computerd's key endpoint;
backups of ControlCell contain the key, just as they contain the authentication secret. No product settings are
read from deployment environment variables. AI updates reload idle spaces; an active space reloads after its
answers finish. Chats using a model no longer offered then run on the new default.

## First installation

1. Generate deployment secrets with `deploy/v2/init-env.sh`; fill in the infrastructure settings and initial
   `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env`. For SSO-only installations, `ADMIN_EMAIL` is sufficient.
2. Configure `deploy/v2/auth.json` (password login is the checked-in default), then build/deploy using the
   deployment guide. `AUTH_CONFIG_FILE` selects another file, relative to `deploy/v2` or absolute.
3. Sign in as the initial admin and configure **Admin → AI → Models**. Without an AI connection, administration and
   existing data remain accessible; chat generation requires a model and either a provider key or a keyless provider.
4. Remove the bootstrap password and redeploy. The bootstrap variables never override an existing administrator.

Authentication configuration changes require a redeploy. The server rejects invalid files instead of silently
falling back to password or anonymous access. Keep stable provider IDs: accounts are bound to those IDs.
Switching between authenticated and anonymous modes requires a data wipe.

## Authentication file

`auth.json` is version 1. It accepts `mode` (`authenticated` or `anonymous`), `publicOrigin` (an optional HTTPS origin), `password` (boolean), `providers`
(array), and `trustedProviders` (array of configured provider IDs). At least one login method must be enabled.
Provider `options` are Better Auth's JSON-compatible options for the selected integration; callbacks/functions
and arbitrary plugin loading are not configuration-file features.

Passwords alone:

```json
{ "version": 1, "mode": "authenticated", "password": true }
```

Add Google (and keep passwords). Provider secrets can be referenced with an `{"env":"NAME"}` leaf; deployment
resolves it from the deployment job's environment, including `.env`, and rejects missing/empty references.
The file itself need not contain credentials.

```json
{
  "version": 1,
  "password": true,
  "providers": [{
    "id": "google",
    "name": "Google",
    "type": "social",
    "options": {
      "clientId": { "env": "GOOGLE_CLIENT_ID" },
      "clientSecret": { "env": "GOOGLE_CLIENT_SECRET" }
    }
  }]
}
```

Use any built-in Better Auth social provider ID (for example `github`, `microsoft`, or `apple`), with that
provider's required options. Register `https://YOUR_HOST/auth/callback/PROVIDER_ID` at the identity provider.
**Admin → General → Authentication** shows the sign-in methods and their callback URLs. Installations exposed on the internet need HTTPS at their reverse proxy;
public origins remain deployment configuration.

Configure Google signup domains in **Admin → General → Authentication**. The provider file configures
Google credentials, while admins control admission. `options.hd` is rejected: remove it before deploying,
then enter the same domain in the admin setting after deployment. No data wipe is needed for this change.
Existing accounts continue to sign in when signup is disabled or their domain is removed. Password accounts
remain provisioned by admins or invitations.

For a reusable configuration, select `deploy/v2/auth.google-workspace.example.json` with `AUTH_CONFIG_FILE`.
Set `AUTH_PUBLIC_ORIGIN`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in the deployment's private `.env`.
The deploy job resolves these references before validating the authentication configuration. An empty or missing
value stops deployment. You can also put literal values in a private authentication file selected by
`AUTH_CONFIG_FILE`. Keep a file containing client secrets outside version control and readable only by its owner.

Set `publicOrigin` to your installation's HTTPS origin, such as `https://baskule.example.com`, when a reverse proxy
terminates TLS. The app uses that origin for authentication callbacks, account-connection callbacks, and links,
and sets authentication cookies as Secure. Forwarded protocol and host headers cannot override this setting.
Without it, local installations derive URLs from their requests. `PUBLIC_ORIGINS` remains the list of additional
origins allowed for state-changing requests; it does not select the public URL.

Create a **Web application** client in [Google Auth Platform](https://console.cloud.google.com/auth/clients).
Register `https://YOUR_HOST/auth/callback/google` as its authorized redirect URI. Use your installation's HTTPS
origin as the authorized JavaScript origin, and its registrable domain under **Branding → Authorized domains**.
Select an **Internal** audience when the project belongs to the intended Workspace organization. Request only
`openid`, `email`, and `profile` for login. Ordinary Google Sign-In clients require Google-side setup in the
console; the similarly named `gcloud iam oauth-clients` commands manage Workforce Identity Federation clients.

For a passwordless first administrator, set `password: false` and `ADMIN_EMAIL` before the first deployment.
After the administrator exists, you can enable `password: true` and redeploy without another data reset.
The administrator signs in through Google, then uses **Admin → People → Copy a password reset link** to create a link and
choose a local password. Other people still need an invitation or an account created by an administrator.
Authentication provider credentials remain installation configuration; admins manage people and Google signup domains in the admin UI.

Company OIDC, using Better Auth's generic OAuth integration:

```json
{
  "version": 1,
  "password": false,
  "providers": [{
    "id": "company",
    "name": "Company SSO",
    "type": "oidc",
    "options": {
      "clientId": { "env": "COMPANY_CLIENT_ID" },
      "clientSecret": { "env": "COMPANY_CLIENT_SECRET" },
      "discoveryUrl": "https://id.example.com/.well-known/openid-configuration",
      "scopes": ["openid", "email", "profile"]
    }
  }]
}
```

OIDC discovery must provide an issuer and JWKS for ID-token verification. Its callback is
`/auth/callback/company`. Additional JSON-compatible generic OAuth options can configure scopes, token-endpoint
authentication and provider parameters. Verification and admission controls are managed by Baskule.

SAML is unsupported because the pinned celld runtime lacks the synchronous certificate and signature APIs
required by Better Auth's SAML integration. Use your identity provider's OIDC connection. Unsupported provider types
fail validation at startup.

`trustedProviders` explicitly trusts a provider to assert an existing account's email even without a verified
email flag. Leave it empty for social/OIDC providers that reliably return verified emails. Public provider-registration/configuration endpoints are blocked;
the file is authoritative. Do not recycle a provider ID for a different identity authority.

## Plugin account connections

Plugin outbound traffic requires HTTPS to public hosts. Admin-added servers may use private addresses and HTTP
on those addresses. The in-isolate `baskule-mcp.internal` host is always refused. OAuth metadata for a public
server may only point to public HTTPS addresses. Requests refuse redirects; MCP requests stay on their origin.
These checks inspect URLs, not DNS answers. Deployment egress rules must deny private and reserved destination
addresses for public hostnames, including DNS rebinding; this is not full SSRF protection.


The administrator installs and grants plugins; users connect their own accounts. Connections are per user and
plugin server across spaces. Personal-account servers are refused in team spaces until an owner enables
personal-account plugins for that space. A connection never grants access beyond the group's plugin policy.

For an MCP server with `credential: "user-oauth"`, ControlCell discovers protected-resource and authorization-server
metadata, registers a public client with DCR, and runs the authorization-code flow with S256 PKCE. It sends the
configured resource identifier as `resource` on authorization, token exchange and refresh requests. Metadata must identify that
same resource and issuer; callback issuer checks follow RFC 9207. Catalog recipes record a distinct resource
identifier where vendor metadata requires one. Custom servers default to their MCP URL. Public servers require HTTPS; admin-added private servers may use HTTP.
OAuth endpoints never follow redirects with credentials. A client-ID metadata document is not served by this version;
servers without DCR use pre-registration.

For a service without dynamic registration, open Admin → Plugins → the plugin → Sign-in setup. Register the
callback address shown there with the vendor, then save its client ID, authentication method and secret.
Values are write-only and encrypted. Saving or removing setup disconnects accounts and cancels pending consent
for every plugin using that vendor; other vendors are unaffected. The saved issuer is pinned: a resource that
changes its authorization server is refused before Baskule sends the client secret. If resource metadata disappears
after setup, the saved issuer supplies discovery. Catalog setup uses the vendor issuer from the reviewed recipe;
custom setup initially requires resource metadata. Plugin accounts are separate from signing in to Baskule.

Server settings accept `oauth: {scopes, params, resource, staticClient}` for `user-oauth` servers. Scopes default
to the resource challenge or metadata; `params` adds vendor authorization parameters, and `resource: false`
omits the resource parameter for vendors that refuse it. `staticClient: true` requires administrator setup.
Protocol parameters such as the callback, state and PKCE cannot be overridden. Nothing uses OpenCode's per-space OAuth store.

UI contract: navigate the signed-in browser to `GET /api/baskule/plugins/:id/connect?server=NAME&returnTo=/PATH`
(`server` can be omitted for a single account server; `returnTo` defaults to `/` and must remain on this origin).
The callback requires the initiating live user session and returns to that path with `pluginId`, `server`, and
`pluginConnection=connected`, or `pluginConnection=error&connectionError=CODE`. Invalid, missing or expired state redirects to Settings → Plugins with `connectionError=invalid_oauth_state`. Callback state is single-use and expires after ten minutes. `GET /api/baskule/plugins` reports each server
with one of `unavailable`, `needs_setup`, `connect`, `reconnect`, or `ready`. The plugin status is the highest-priority
server status in that order. A skills-only plugin is ready when assigned and unpaused. `DELETE /api/baskule/plugins/:id/connection[?server=NAME]` immediately
forgets one or all plugin connections, cancels pending consent and prevents an in-flight refresh from restoring them.
Initial Connect failures also return to Settings → Plugins with a plain error.

Better Auth's `account.encryptOAuthTokens: true` encrypts access and refresh tokens with the installation secret;
login ID tokens are discarded after validation. Organization keys, plugin tokens, refresh data, pending PKCE verifiers and admin OAuth
client secrets use AES-256-GCM with a domain-separated HKDF key derived from the same secret and authenticated row
identity. Backups containing both the database and its generated secret remain sensitive. Keep `AUTH_SECRET` stable;
changing it invalidates sessions and encrypted credentials. Deploying this configuration layout requires the data wipe below;
there is no conversion of plaintext tokens or a plaintext read path in plugin connection storage.

## Invitations and native clients

Normal installations are invitation-only by default. In **Administration → General → Authentication**, admins can allow Google signup for exact email domains. Separate domains with commas; leave the list empty to require invitations again. Google must verify the email and return a matching Workspace domain (`hd`). New accounts are regular members with a personal workspace; team membership still requires an invitation or an admin. Changes apply immediately and persist across restarts. Other providers and email/password remain invitation-only. Accepting an invitation with an external
provider creates a passwordless local account, consumes the email-bound invitation, and grants the invited
memberships. It does **not** issue a session: the selected provider must then prove the invited identity.
If that login is interrupted, the account exists; sign in again with the invited address. Enabling a provider alone
does not enable self-registration or automatic enterprise provisioning.

Web browsers use cookies. Desktop and mobile can use the system browser for external providers: sign in and
explicitly approve **Connect app**, then return to the app. The initiating app alone holds the polling secret;
approval issues a connect code (as in **Settings → Desktop app → Connect a device**) that the app's next poll redeems for its own new
session, once, within 10 minutes. No session token is placed in a URL. Password
login remains available directly in the clients when enabled. The mobile app exposes server selection before
showing the installation's available login methods.

## Anonymous test installation

```json
{ "version": 1, "mode": "anonymous" }
```

This completely disables login. Everyone on every client shares the same **Anonymous** identity and **Shared**
workspace, including administration access. No per-browser anonymous accounts, passwords, bearer tokens or
sessions are created. Native connections send no authentication headers or socket tickets. People, invitations
and password controls are unavailable. Use a separate installation with disposable data for this mode.

## Infrastructure stays in deployment configuration

Listener/bind address, ports, public origins, TLS/proxy settings, storage credentials, internal service tokens,
CPU/memory limits, celld heap/timeouts, and bootstrap admin details stay in `.env`/Compose. computerd reads the
current idle policy through its authenticated runtime-settings endpoint. If that read fails, that idle check
does not stop computers using a guessed policy.

## Upgrading an earlier installation

The vendor-setup layout drops per-server OAuth clients and deletes installed plugin data. Reinstall plugins,
assign groups, enter organization keys and vendor clients, then reconnect accounts after the authorized deploy.
This reset retains users, groups, spaces and chats.

This change replaces the product configuration layout. Wipe the installation's data when deploying it:
back up if wanted, stop and purge with `deploy/v2/down.sh --purge`, prepare `.env` and `auth.json`, then build and
run `deploy/v2/up.sh` and configure the product in the admin area. Rebuild clients for their new login paths.
There is no import or fallback from the retired organization/AI environment settings.

The encrypted-key schema recreates `plugin_secret`; existing organization keys are removed. Before deployment,
obtain the installation owner's authorization and retain the keys privately if they must be re-entered. Deploy
the new build, let ControlCell apply the schema, and re-enter organization keys in Admin → Plugins. Users,
groups, spaces and chats are untouched. No plaintext reader or data conversion is retained.

The assignment schema drops `user_plugin` and its member activation preferences. Existing plugins retain their
stored Pause state. The launch reset removes plugin data with the installation owner's authorization; users,
groups, spaces and chats are retained. No activation route or compatibility reader remains.
