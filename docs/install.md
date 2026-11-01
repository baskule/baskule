# Install Baskule

Use a Linux x86-64 machine with Docker Engine 25+, Compose 2.24.4+, and curl. Start with 4 CPU cores,
24 GiB RAM, and 80 GB free disk. OpenShell runs a privileged container with its own Docker daemon.
For several machines, use the [cluster guide](install-cluster.md).

```sh
curl -fLO https://github.com/baskule/baskule/releases/latest/download/docker-compose.yml
docker compose up -d
docker compose logs setup        # prints the one-time link that creates the first admin
```

To change defaults, create `.env` next to the compose file, uncomment what you need, then `docker compose up -d`.

<!-- install-env:start -->
```dotenv
# Bind address (default 127.0.0.1); 0.0.0.0 must be reachable only by the proxy or trusted clients.
# Rootless Docker hides client addresses; enforce access and rate limits at your outer proxy.
#BASKULE_BIND=127.0.0.1
# HTTP port (default 47090).
#BASKULE_PORT=47090
# Public HTTPS origin (unset by default); only needed for SSO callbacks with a forwarding HTTPS proxy.
#PUBLIC_ORIGINS=https://baskule.example.com
# SSO example: optional OIDC provider, password sign-in kept on; publicOrigin fixes callback URLs.
#AUTH_CONFIG='{"version":1,"password":true,"publicOrigin":"https://baskule.example.com","providers":[{"id":"company","type":"oidc","name":"Company","options":{"clientId":"YOUR_CLIENT_ID","clientSecret":"YOUR_CLIENT_SECRET","discoveryUrl":"https://id.example.com/.well-known/openid-configuration"}}]}'
# External S3 endpoint (default http://baskule-rustfs:47093); uncomment all five S3 settings together.
#S3_ENDPOINT=https://s3.example.com
# S3 region (default us-east-1).
#S3_REGION=us-east-1
# Shared bucket (default baskule).
#CELLD_BUCKET_NAME=baskule
# External S3 access key (default generated local RustFS key).
#S3_ACCESS_KEY=YOUR_ACCESS_KEY
# External S3 secret key (default generated local RustFS secret).
#S3_SECRET_KEY=YOUR_SECRET_KEY
# Memory cap for each of the two platform nodes (default 3g).
#CELLD_MEMORY=3g
# Memory cap for OpenShell and all computers together (default 8g).
#OPENSHELL_MEMORY=8g
# Memory cap per computer within OpenShell (default 3Gi).
#COMPUTER_MEMORY=3Gi
```
<!-- install-env:end -->

You can download this commented example with
`curl -fL https://github.com/baskule/baskule/releases/latest/download/baskule.env.example -o .env`.
No value in it is required. Keep an edited `.env` private. Secrets are generated in separate storage, platform,
computerd, and OpenShell volumes; explicit environment values override them. Keep the installation directory
and Compose project name stable.

## Open it

Open the link from `docker compose logs setup` and create the first admin. The link works once, then becomes
useless. Initial image imports can take several minutes. In **Admin → AI → Models**, configure your provider and
model, then invite people. Password sign-in is enabled by default.

Locally, use `http://127.0.0.1:47090`. For a remote machine, tunnel the loopback port:

```sh
ssh -L 47090:127.0.0.1:47090 user@server
```

Open the setup link on your own machine while the tunnel runs. For HTTPS, put a proxy in front of port 47090.
With Caddy on the host:

```caddyfile
baskule.example.com {
    reverse_proxy 127.0.0.1:47090
}
```

Forward Host, X-Forwarded-Proto, client IP, WebSockets, and streaming responses without buffering. The bundled edge
trusts only the pinned Docker network gateway, `172.30.90.1`, where a host-local proxy appears through docker-proxy,
and forwards the public scheme and host. Direct clients cannot supply forwarded addresses or hosts. No origin setting is needed for
password sign-in. With `BASKULE_BIND=0.0.0.0`, restrict the port to your proxy or trusted clients with a firewall.
Rootless Docker hides client addresses; enforce access and rate limits at the outer proxy. Only publish your HTTPS proxy. To create the admin through that proxy, open
`https://baskule.example.com/setup#token=` followed by the token from the setup log. Optional `PUBLIC_URL` changes
the printed link. Browsers need HTTPS or localhost for microphone access.

## Optional settings

The example above lists common settings. All settings are optional:

| Setting | Default | Purpose |
| --- | --- | --- |
| `BASKULE_BIND`, `BASKULE_PORT` | `127.0.0.1`, `47090` | Published HTTP listener |
| `PUBLIC_URL` | `http://127.0.0.1:<BASKULE_PORT>` | Address printed in the setup link |
| `PUBLIC_ORIGINS` | unset | Additional allowed origins; set with SSO public URL |
| `AUTH_CONFIG` | password sign-in | Authentication JSON; `publicOrigin` fixes SSO callback URLs |
| `S3_ENDPOINT`, `S3_REGION`, `CELLD_BUCKET_NAME` | local RustFS, `us-east-1`, `baskule` | Shared storage |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | generated local keys | External storage credentials |
| `CELLD_MEMORY`, `OPENSHELL_MEMORY`, `COMPUTER_MEMORY` | `3g`, `8g`, `3Gi` | Memory caps |
| `COMPOSE_PROFILES` | unset | Set `traces` to enable the trace collector |

The default memory caps total 15.75 GiB. Limits are not reservations. Each computer defaults to 2 CPU cores
and 3 GiB within OpenShell's aggregate cap. See [installation settings](installation-settings.md) for app settings.

## SSO

Set `AUTH_CONFIG` in `.env`, with `publicOrigin` and `PUBLIC_ORIGINS` pointing to the public HTTPS URL. The example
keeps passwords enabled alongside OIDC. Use `"password":false` for SSO only, then create the admin through the
setup link without a password and sign in through SSO with that email. Use
[installation settings](installation-settings.md#authentication-file) for providers and callbacks. Environment
references such as `{"env":"OIDC_SECRET"}` resolve from the optional `.env`. Run `docker compose up -d` after edits.
Changing between anonymous and authenticated modes requires wiping alpha data.

## External S3

Before first start, set all five storage values in the example. The local RustFS container stays idle while the
platform uses the external endpoint. Bootstrap waits only for that configured endpoint; local RustFS health does
not block external storage. The bucket must support celld's conditional writes and consistency. The
bootstrap job creates it if absent; pre-create it if credentials forbid creation. Changing buckets selects another
installation. Computer disks and gateway keys stay local. Back up the external bucket separately.

## Backup and restore

Stop services before copying state:

```sh
docker compose down
umask 077
docker compose run --rm -T backup > backup.tar.gz
```

Save the archive, compose file, and optional `.env` off the machine. The archive includes generated secrets,
local RustFS, gateway state and keys, and the private Docker store containing computer disks. Node caches are
disposable. Snapshot external S3 separately while services are stopped. Protect backups like credentials.
Start again with `docker compose up -d`.

To restore, place the saved compose file and optional `.env` in a directory whose destination volumes are empty.
Restore external S3 first if used, then run:

```sh
docker compose run --rm -T restore < backup.tar.gz
docker compose up -d
```

Restore refuses nonempty volumes and re-admits restored computer disks. Files under `/sandbox/space` persist;
other computer files are temporary. Restore the same release before updating.

## Update

Read release notes for alpha data wipes. Back up first and keep the old compose file with the backup.
For an installation using the earlier shared secret volume or an unpinned Docker network, run
`docker compose down` with the old file before replacing it. Bootstrap creates the scoped secret volumes and
regenerates defaults; explicit `.env` values still override them. Buckets and computer disks remain. The old
`<project>_baskule-secrets` volume is unused and can be removed after verifying the update and preserving a backup.
Then:

```sh
curl -fLO https://github.com/baskule/baskule/releases/latest/download/docker-compose.yml
docker compose up -d
```

The compose file selects the released version. Keep your optional `.env`; no version edit or secret regeneration
is needed. Updates can interrupt chats and commands. Check sign-in and a computer command after reconnecting.
`docker compose down` stops services and retains data. `docker compose down -v` deletes all local data and secrets;
it does not delete external S3. For an authorized alpha wipe, preserve backups, remove volumes, empty external S3
if used, and start the new release with a fresh setup link.

## Troubleshooting

- `docker compose ps -a` shows health and one-shot exit status.
- `docker compose logs setup baskule-bootstrap baskule-deploy` shows setup, storage, and deployment failures.
- `docker compose logs baskule-celld-a baskule-celld-b` shows platform errors.
- `docker compose logs baskule-computerd baskule-openshell` shows computer startup errors.
- A new platform node cannot become healthy before the first deployment. Check the deploy job and S3 first.
- A GHCR permission error means your account cannot read the release packages.

For optional traces, set `COMPOSE_PROFILES=traces`, `BASKULE_CELLD_OTEL=http://baskule-traces:4318`,
`BASKULE_OTLP_TRACES_URL=http://baskule-traces:4318/v1/traces`, and
`BASKULE_OPENSHELL_OTLP=http://baskule-traces:4317` in `.env`. The trace UI listens on the bind address at
port 47098. Restarting it clears traces.
