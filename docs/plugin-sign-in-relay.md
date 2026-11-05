# Plugin sign-in relay

Many vendors only let registered, reviewed OAuth apps sign people in, and their MCP servers do not
support automatic client registration. Before this change, every Baskule installation had to create
its own app for each of these vendors. The sign-in relay lets an installation use one app per vendor
that Baskule registers, so an administrator turns a vendor on with one click.

The relay is a private Cloudflare Worker (`baskule/connect`) at `https://connect.baskule.com`. This
document is the protocol contract between Baskule installations and the relay.

## What the relay does and does not do

- It holds Baskule's client ID for each vendor, and the client secret when the vendor needs one.
- It shows the member which installation they are connecting to before sending them to the vendor.
- It is the single redirect URI registered with every vendor, and bounces the browser back to the
  installation that started the sign-in.
- It adds the client secret to code exchange and refresh requests.

It stores nothing: no tokens, no installations, no accounts. State is carried in a signed `state`
parameter. MCP traffic goes directly from the installation to the vendor. Tokens pass through the
relay only in transit, during code exchange and refresh.

## Sign-in modes per vendor

| Mode | Vendors | Administrator setup |
|---|---|---|
| Automatic registration | Notion, Linear, Atlassian, Stripe, Figma and the other `client: "dynamic"` vendors | None |
| Baskule sign-in (relay) | Microsoft, Slack, GitHub, Dropbox, Box, Zoom, Canva, Asana, HubSpot | One click, plus the directory tenant GUID for Microsoft. "Your own app" stays available. |
| Your own app only | Google, Salesforce, Shopify, Docusign | The administrator registers an app in the vendor console |

- **Google** stays "your own app". Baskule does not hold a Google app: Gmail and Drive scopes would need
  an annual security assessment (CASA) and every installation would share one Google quota. Instead,
  one Google Cloud project and one OAuth client serve every Google service, and the setup dialog lists
  the exact steps and values. The supported setup is an **Internal** app, which only accounts in the
  administrator's own Google Workspace organization can use and which needs no Google verification.
- **Salesforce** needs an External Client App and setup in each customer organization, so a shared app
  does not help.
- **Shopify and Docusign** are still held in the catalog (`notYet`).

The catalog marks relay vendors with `signIn.relay: true`. Whether the relay currently serves a vendor
is decided by the relay's `/v1/vendors` list, so a vendor can be turned on without a Baskule release
once the catalog marks it.

## Protocol (v1)

`RELAY` is the installation's configured relay URL (`BASKULE_CONNECT_URL`, default
`https://connect.baskule.com`). All endpoints are versioned under `/v1`. A breaking change adds `/v2`
and keeps `/v1` while `app/packages/contracts/release-compatibility.json` still covers releases that
call it.

### `GET /v1/vendors`

Public and cacheable for 5 minutes. Lists only vendors whose client ID (and secret, when required) is
configured on the relay.

```json
{ "vendors": [ { "id": "github", "clientId": "Iv1.…", "tokenEndpointAuthMethod": "client_secret_post" } ] }
```

Vendor IDs match `[a-z][a-z0-9]*`; an installation ignores entries it does not recognise.
`tokenEndpointAuthMethod` is the method the relay uses toward the vendor. The installation stores it so
the existing `token_endpoint_auth_methods_supported` check still applies.

### `GET /v1/authorize?vendor=<id>&origin=<origin>&url=<authorization URL>`

The installation builds the vendor authorization URL exactly as it does for its own app, with
`client_id` from `/v1/vendors` and `redirect_uri=RELAY/v1/callback`, then redirects the browser here.

The relay rejects the request with a plain error page unless:

- `vendor` is served;
- `origin` is an `http` or `https` origin with no path, query, credentials or fragment;
- `url` matches one of the vendor's allowed authorization endpoints;
- `url` has `response_type=code`, the vendor's `client_id`, `redirect_uri=RELAY/v1/callback`,
  `code_challenge_method=S256`, a `code_challenge`, and a `state` of at most 512 characters.

It then shows a confirmation page naming the vendor and highlighting the installation's host
("Connect your GitHub account to baskule.example.com?"), with a warning for `http` and IP-address
origins. **Continue** is a plain link, clickable after about a second, to the same URL with `state`
replaced by the relay state:

```
base64url(JSON {"v":1,"o":origin,"s":inner_state,"d":vendor,"n":nonce,"e":expiry_ms}) "." base64url(HMAC-SHA256(STATE_KEY, payload))
```

The same response sets `__Host-bk_<nonce>=1; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Lax`.
This binds the sign-in to the browser that saw the confirmation page: a state minted by anyone else
carries a nonce that the member's browser never received. The relay state expires after 15 minutes.

### `GET /v1/callback`

The single redirect URI registered with every vendor. The relay verifies the state signature and
expiry and requires the `__Host-bk_<n>` cookie, which it clears (each state is single-use). It then redirects with `302` to `<o>/api/baskule/plugins/oauth/callback`, carrying `code`,
`state=<s>`, and `iss`, `error` and `error_description` unchanged when present. An invalid or expired
state shows an error page and redirects nowhere.

### `POST /v1/token/<vendor>`

Form-encoded, as a normal token request, plus `token_endpoint=<URL>`:

- `token_endpoint` must match one of the vendor's allowed token endpoints;
- `grant_type` is `authorization_code` (with `code`, `code_verifier` and `redirect_uri=RELAY/v1/callback`)
  or `refresh_token` (with `refresh_token`);
- the relay drops any client credentials sent by the caller, always sets `client_id`, adds the secret
  using the vendor's method, and forwards the request. The installation sends `client_id` too.

The vendor's status and JSON body are returned unchanged (a non-JSON vendor response becomes `502`), with `cache-control: no-store`. Relay
refusals use `400` with `{"error":"relay_<reason>"}`. A vendor that cannot be reached returns `502`
with `{"error":"relay_vendor_unavailable"}`.

## Security

- **PKCE (S256) is mandatory.** An intercepted code is useless without the installation's verifier.
- **Phishing with Baskule's name.** Someone could start a sign-in that returns to their own server.
  The confirmation page names the destination host, and the callback only bounces a state whose
  nonce cookie was set on that page in the same browser, so the page cannot be skipped. The relay
  logs route, vendor, outcome and destination host (never codes, states or tokens) so abuse is
  visible. Installation registration is left out until abuse shows it is needed.
- **Issuer checks stay in the installation.** It pins the vendor issuer from the catalog and checks
  `iss` against discovery, as for its own app. The relay is never treated as the issuer.
- **Disconnecting stays local.** Revoking a Google or Microsoft grant would revoke it for every
  installation using the shared app.
- **Relay outage.** Refreshes fail with `unavailable`, not `reconnect`, including `429`, `408`,
  `temporarily_unavailable`, `server_error` and relay `5xx`. The refresh token is kept. Only a vendor
  answer that the grant is dead clears it: `invalid_grant`, or the HTTP 200 forms Slack
  (`ok:false`, `invalid_refresh_token`) and GitHub (`bad_refresh_token`) use.

## Installation behaviour

- `vendor_setup.data` holds either the existing own-app shape (`{clientId, clientSecret?,
  tokenEndpointAuthMethod, issuer}`, read as own app) or `{mode: "relay", tenant?, issuer}`. No
  migration is needed.
- Switching a vendor between modes clears its connections and pending sign-ins, as changing the own
  app already does.
- Microsoft accepts a directory tenant GUID and stores it in lowercase so its pinned issuer matches Microsoft discovery. Tenant domain names are not accepted.
- A successful vendor list that omits a vendor reports `relay_vendor_not_served`; a relay that cannot be reached reports `relay_vendor_unavailable`.
- `BASKULE_CONNECT_URL` is a deployment setting. An installation that never chooses Baskule sign-in
  never contacts the relay.
