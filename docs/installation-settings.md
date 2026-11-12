# Installation and organization settings

The installer owns authentication and infrastructure. An organization administrator owns product settings in
the admin area: **Admin → General → Organization** (organization name, computer idle timeout) and **Admin → AI →
Models** (the AI provider: Anthropic, Mistral, OpenAI, OpenCode (free), or a custom OpenAI-compatible endpoint;
its endpoint and key; the model for chats, chosen from the models the key can use). The installation offers exactly
one provider and model. A new installation has none: until an administrator saves one, the Models page starts with
no provider selected and chats answer that an administrator needs to choose an AI provider.
A change saves only after the provider accepts the key and the model; the ControlCell
checks again before storing it. OpenCode (free) uses DeepSeek V4.1 Flash Free without an API key. Prompts go to
OpenCode's servers under its terms. The model's image/PDF inputs, context window and maximum output in tokens are
prefilled when the provider or models.dev knows them. Set them to the model's actual limits: OpenCode uses them to
decide when to compact context automatically.
People, invitations, roles and space membership are under **Admin → People** and **Admin → Spaces**.
Groups (**Admin → People → Groups**; every person is in the built-in **Everyone**) grant permissions such as
creating team spaces and can be given access to plugins. Plugins are under **Admin → Plugins**: nothing is
installed by default. Administrators install them from the Anthropic, Cursor and xAI catalogs, a GitHub link, an MCP server
address, or Composio and Pipedream, choose who may use them, and finish their setup; members sign in to plugin
apps and switch plugins on or off in **Settings → Plugins**. See [plugins](plugins.md).

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
report `apiKeyConfigured: true`, and use OpenCode's `public` bearer token. Backups of ControlCell contain the key, just as they contain the authentication secret. No product settings are
read from deployment environment variables. AI updates reload idle spaces; an active space reloads after its
answers finish. Chats using a model no longer offered then run on the new default.

## First installation

1. Start Compose as described in the [installation guide](install.md). Open the one-time link from
   `docker compose logs setup` to create the first admin. SSO-only installations omit the password.
2. Password login is the default. For SSO, put your authentication JSON in the single-quoted `AUTH_CONFIG` value
   in `.env`. For example: `AUTH_CONFIG='{"version":1,"password":true}'`. The source-build override can instead
   mount `deploy/auth.json`, with `AUTH_CONFIG_FILE` selecting another file. Kubernetes uses the chart's `authConfig` value; see the [Kubernetes guide](install-kubernetes.md).
3. Sign in as the initial admin and configure **Admin → AI → Models**. Without an AI connection, administration and
   existing data remain accessible; chat generation requires a model and either a provider key or a keyless provider.
4. Invite people from the admin area. The setup token cannot create another admin after setup.

Run `docker compose up -d` after Compose authentication changes, or `helm upgrade` with the updated values for Kubernetes. The server rejects invalid files instead of silently
falling back to password or anonymous access. Keep stable provider IDs: accounts are bound to those IDs.
Switching between authenticated and anonymous modes has no migration. Back up first and follow the release's
documented steps; existing data must be removed.

## Authentication file

Authentication JSON is version 1. An optional `auth.json` uses the same format. It accepts `mode` (`authenticated` or `anonymous`), `publicOrigin` (an optional HTTPS origin), `password` (boolean), `providers`
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

For a reusable source-build configuration, select `deploy/auth.google-workspace.example.json` with `AUTH_CONFIG_FILE`.
Released installations put the same JSON in `AUTH_CONFIG` in `.env`.
Set `AUTH_PUBLIC_ORIGIN`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in the deployment's private `.env`.
The deploy job resolves these references before validating the authentication configuration. An empty or missing
value stops deployment. You can also put literal values in a private authentication file selected by
`AUTH_CONFIG_FILE` in a source build. Keep a file containing client secrets outside version control and readable only by its owner.

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

For a passwordless first administrator, set `password: false` before the first deployment, then create the admin with the setup link.
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

Members connect their own accounts; connections are per person and plugin app across spaces, one account per
app, and never grant access beyond the plugin's access. Tool calls use the turn author's connection. Setup,
sign-in clients and outbound rules: [plugins](plugins.md).

For an app with member sign-in, ControlCell discovers protected-resource (RFC 9728) and authorization-server
(RFC 8414) metadata, uses the administrator's client for that issuer or registers one dynamically (RFC 7591), and
runs the authorization-code flow with S256 PKCE. It sends the resource the metadata declares as `resource`
(RFC 8707) on authorization, token exchange and refresh, and checks the callback issuer (RFC 9207).

UI contract: navigate the signed-in browser to
`GET /api/baskule/plugins/:id/servers/:serverId/connect?returnTo=/PATH` (`returnTo` defaults to `/settings/plugins`
and must stay on this origin). OAuth returns to `/api/baskule/plugins/oauth/callback`, Composio and Pipedream to
`/api/baskule/plugins/provider/callback`. Both require the session that started the sign-in and redirect to
`returnTo` with `plugin=<id>&connection=connected`, or `connection=error&code=CODE` where `CODE` is a plugin error
code (`oauth_failed`, `oauth_client_required`, `provider_rejected`, `provider_unavailable`, `invalid_request`…)
or a call refusal (`not_allowed`, `plugin_off`, `setup_incomplete`). Sign-in state is single-use and expires after
ten minutes. Anonymous installations refuse member sign-in, because everyone reaching them is the same person.
`DELETE /api/baskule/plugins/:id/servers/:serverId/connection` disconnects at once and revokes a Composio or
Pipedream account.

Better Auth's `account.encryptOAuthTokens: true` encrypts access and refresh tokens with the installation secret;
login ID tokens are discarded after validation. Plugin values, plugin tokens, pending PKCE verifiers, OAuth client
secrets and Composio and Pipedream credentials use AES-256-GCM with a domain-separated HKDF key derived from the same secret and authenticated row
identity. Backups containing both the database and its generated secret remain sensitive. ControlCell generates and persists the installation secret in its database;
losing it invalidates sessions and encrypted credentials.

## Invitations and native clients

Normal installations are invitation-only by default. In **Admin → General → Authentication**, admins can allow Google signup for exact email domains. Separate domains with commas; leave the list empty to require invitations again. Google must verify the email and return a matching Workspace domain (`hd`). New accounts are regular members with a personal workspace; team membership still requires an invitation or an admin. Changes apply immediately and persist across restarts. Other providers and email/password remain invitation-only. Accepting an invitation with an external
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

See [background push integration](background-push-integration.md) to configure mobile notifications.

## Infrastructure stays in deployment configuration

Listener/bind address, ports, public origins, TLS/proxy settings, storage credentials, internal service tokens,
CPU/memory limits, celld heap/timeouts, and the setup token stay in `.env`/Compose or Helm values. computerd reads the
current idle policy through its authenticated runtime-settings endpoint. If that read fails, that idle check
does not stop computers using a guessed policy.

## Upgrade

Back up and update the installation using the [Compose update procedure](install.md#update) or [Kubernetes upgrade procedure](install-kubernetes.md#upgrade-and-scale).
Release notes list changes that cannot migrate existing data, with the affected data and deployment steps.
Follow them before updating, then configure the product in the admin area.
