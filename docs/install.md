# Install Baskule

Use a Linux x86-64 machine with Docker Engine 25+, Compose 2.24.4+, and curl. computerd uses the host Docker socket.
For several machines, use the [Kubernetes installation](install-kubernetes.md), the only cluster install.

To try one running computer at a time, use at least 2 CPU cores, 8 GiB RAM, and 20 GB free disk.
Set these limits in `.env` next to the Compose file:

```dotenv
CELLD_MEMORY=2g
COMPUTER_MEMORY=2Gi
```

For a team, use at least 4 CPU cores and budget 10 GiB RAM for the host and services,
plus 3 GiB per running computer at the default limits. Tested installations used about 3 GiB with three
computers running; the team budget also covers every service reaching its limit.
Larger tasks or optional services need more RAM.

Start with 20 GB free disk for either size. Released images use about 4.8 GB, and a small tested installation
used about 0.3 GB in volumes. Allow more for files, backups and their temporary copies, up to 2 GiB of local
cache per platform node, and retained image sets after updates. Prune old images after verifying an update.

For 0.5.1 and earlier, under `baskule-rustfs` in the downloaded Compose file, change `mem_limit: 1g`
to `mem_limit: 2g` to avoid out-of-memory restarts.

```sh
curl -fLO https://github.com/baskule/baskule/releases/latest/download/docker-compose.yml
docker compose up -d --remove-orphans
docker compose logs setup        # prints the one-time link that creates the first admin
```

To change defaults, create `.env` next to the compose file, uncomment what you need, then `docker compose up -d`.

<!-- install-env:start -->
```dotenv
# Built-in HTTPS domain (unset by default); point DNS here and allow inbound TCP 80/443 and UDP 443 (HTTP/3).
#BASKULE_DOMAIN=baskule.example.com
# Edge listener: http or https (lowercase; default http). HTTPS requires BASKULE_DOMAIN and publishes on all IPv4/IPv6 interfaces.
#BASKULE_EDGE=https
# HTTP bind address (default 127.0.0.1); ignored by built-in HTTPS.
# An HTTP bind of 0.0.0.0 must be reachable only by your proxy or trusted clients.
# Rootless Docker hides client addresses; built-in HTTPS clients share one sign-in budget.
# With your own proxy, enforce access and rate limits there.
#BASKULE_BIND=127.0.0.1
# HTTP port (default 47090).
#BASKULE_PORT=47090
# Trusted proxy addresses/CIDRs, space-separated (default empty: trust nobody).
# Use private_ranges for a host-local proxy only with loopback HTTP and access restricted to trusted sources.
# The proxy must replace X-Forwarded-For with the peer address (Caddy default); never append incoming XFF.
# nginx: proxy_set_header X-Forwarded-For $remote_addr;
# With private_ranges, private-address LAN/VPN clients share the proxy's sign-in budget.
#BASKULE_TRUSTED_PROXIES=private_ranges
# Additional allowed origins (unset by default); needed for SSO callbacks or an untrusted outer proxy.
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
# Memory cap per computer (default 3Gi).
#COMPUTER_MEMORY=3Gi
# Trace UI bind (default 127.0.0.1), independent of BASKULE_BIND; requires COMPOSE_PROFILES=traces.
#BASKULE_TRACES_BIND=127.0.0.1

# Network and DNS for host Docker computers.
#COMPUTER_NETWORK=${COMPOSE_PROJECT_NAME}-computers
#COMPUTER_DNS=1.1.1.1,8.8.8.8
```
<!-- install-env:end -->

You can download this commented example with
`curl -fL https://github.com/baskule/baskule/releases/latest/download/baskule.env.example -o .env`.
No value in it is required. Keep an edited `.env` private. Secrets are generated in separate storage, platform,
and computerd volumes; explicit environment values override them. Keep the installation directory
and Compose project name stable.

## Open it

Open the link from `docker compose logs setup` and create the first admin. The link works once, then becomes
useless. Initial image pulls can take several minutes. In **Admin → AI → Models**, configure your provider and
model, then invite people. Password sign-in is enabled by default.

### Built-in HTTPS (recommended)

Point your domain's DNS at the machine and allow inbound TCP ports 80 and 443, plus UDP 443 for HTTP/3. Set these two lines in `.env`:

```dotenv
BASKULE_DOMAIN=baskule.example.com
BASKULE_EDGE=https
```

Run `docker compose up -d`, then read `docker compose logs setup`. The link uses `https://baskule.example.com`.
Caddy obtains and renews certificates, redirects HTTP to HTTPS, and keeps certificates in the edge data volume.
HTTPS publishes on all IPv4 and IPv6 interfaces, regardless of `BASKULE_BIND`.
No `PUBLIC_ORIGINS` is needed for password sign-in. Under rootless Docker, all built-in HTTPS clients share one
sign-in rate-limit budget because the edge cannot see their individual addresses. Browsers need HTTPS or localhost
for microphone access.

### Local access or SSH tunnel

With the default HTTP listener, open `http://127.0.0.1:47090`. For a remote machine, tunnel the loopback port:

```sh
ssh -L 47090:127.0.0.1:47090 user@server
```

Open the setup link on your own machine while the tunnel runs.

### Your own reverse proxy

Keep the default loopback HTTP bind. With Caddy on the host:

```caddyfile
baskule.example.com {
    reverse_proxy 127.0.0.1:47090
}
```

Set `BASKULE_TRUSTED_PROXIES=private_ranges` in `.env` for a host-local proxy. Keep HTTP bound to loopback and
restrict access to trusted sources. Loopback binding alone is not an isolation boundary. Prefer exact proxy addresses
when possible. For a separate proxy, bind HTTP to a private address, restrict access to the proxy, and set
`BASKULE_TRUSTED_PROXIES` to its address or CIDR as seen by the edge. List multiple entries separated by spaces.
Forward Host, X-Forwarded-Proto, client IP, WebSockets, and streaming responses without buffering.

The proxy must **replace** X-Forwarded-For with its peer's address, rather than append client-supplied values.
Caddy does this by default. With nginx, use `proxy_set_header X-Forwarded-For $remote_addr;` instead of
`$proxy_add_x_forwarded_for`. With `private_ranges`, private-address LAN/VPN clients share the proxy's sign-in
rate-limit budget. Appending incoming X-Forwarded-For lets those clients spoof addresses and bypass that limit.
Run `docker compose up -d` after edits.

The edge trusts nobody by default. Explicit trust preserves the HTTPS scheme and host; no `PUBLIC_ORIGINS` is
needed for password sign-in. Without trust, set `PUBLIC_ORIGINS=https://baskule.example.com` to permit that origin;
all clients behind the proxy share its sign-in rate-limit bucket. Rootless Docker can hide client addresses;
enforce access and rate limits at your outer proxy. With `BASKULE_BIND=0.0.0.0`, restrict the HTTP port to your
proxy or trusted clients with a firewall. Only publish your HTTPS proxy.

To create the admin through your proxy, open `https://baskule.example.com/setup#token=` followed by the token from
the setup log. Optional `PUBLIC_URL=https://baskule.example.com` changes the printed link.

## Plugins folder

Optionally uncomment `- ./plugins:/plugins:ro` under `baskule-deploy.volumes` in the downloaded
Compose file, create `plugins/`, and run `docker compose up -d`. See [folder plugins](plugins.md)
for package layouts and sync behavior.

## Optional settings

The example above lists common settings. All settings are optional:

| Setting | Default | Purpose |
| --- | --- | --- |
| `BASKULE_DOMAIN`, `BASKULE_EDGE` | unset, `http` | Edge accepts lowercase `http` or `https`; HTTPS requires a domain and publishes TCP 80/443 and UDP 443 on all IPv4/IPv6 interfaces |
| `BASKULE_BIND`, `BASKULE_PORT` | `127.0.0.1`, `47090` | HTTP listener only; both settings are ignored by built-in HTTPS |
| `BASKULE_TRUSTED_PROXIES` | empty | Proxy addresses/CIDRs trusted to forward scheme, host and client IP |
| `PUBLIC_URL` | `https://<BASKULE_DOMAIN>` if set, otherwise `http://127.0.0.1:<BASKULE_PORT>` | Address printed in the setup link |
| `PUBLIC_ORIGINS` | unset | Additional allowed origins; set for SSO or an untrusted outer proxy |
| `AUTH_CONFIG` | password sign-in | Authentication JSON; `publicOrigin` fixes SSO callback URLs |
| `S3_ENDPOINT`, `S3_REGION`, `CELLD_BUCKET_NAME` | local RustFS, `us-east-1`, `baskule` | Shared storage |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | generated local keys | External storage credentials |
| `CELLD_MEMORY`, `COMPUTER_MEMORY` | `3g`, `3Gi` | Memory caps |
| `COMPOSE_PROFILES` | unset | Set `traces` to enable the trace collector |
| `BASKULE_TRACES_BIND`, `BASKULE_TRACES_PORT` | `127.0.0.1`, `47098` | Trace UI listener, independent of the HTTP and HTTPS edge |

Each computer has its own resource limits. See [installation settings](installation-settings.md) for app settings.
The computerd entrypoint discovers the socket group automatically and runs as `node`.
The socket grants Docker administration privileges. Docker must expose the iptables
DOCKER-USER chain; nftables-only Docker is unsupported. The private-network guard
fails closed: ensure returns HTTP 503 without creating a computer if rules cannot be verified.
`COMPUTER_DNS` defaults to public resolvers because private DNS upstreams are blocked.
See [computerd](../computerd/README.md) for isolation and backend details.

## SSO

Set `AUTH_CONFIG` in `.env`, with `publicOrigin` and `PUBLIC_ORIGINS` pointing to the public HTTPS URL. The example
keeps passwords enabled alongside OIDC. Use `"password":false` for SSO only, then create the admin through the
setup link without a password and sign in through SSO with that email. Use
[installation settings](installation-settings.md#authentication-file) for providers and callbacks. Environment
references such as `{"env":"OIDC_SECRET"}` resolve from the optional `.env`. Run `docker compose up -d` after edits.
Switching between anonymous and authenticated modes has no migration. Back up first and follow the release's
documented steps; existing data must be removed.

## External S3

Before first start, set all five storage values in the example. The local RustFS container stays idle while the
platform uses the external endpoint. Bootstrap waits only for that configured endpoint; local RustFS health does
not block external storage. The bucket must support celld's conditional writes and consistency. Verify it with
`celld diagnose` as described in [S3 conditional-write compatibility](storage-conformance.md). The bootstrap job
creates it if absent; pre-create it if credentials forbid creation. Changing buckets selects another
installation. Computer disks stay local. Back up the external bucket separately.

## Backup and restore

Stop services and computers before copying state. Replace `<instance>` below with
`COMPUTERD_INSTANCE`, defaulting to the Compose project name (`docker compose config --format json | jq -r .name`):

```sh
docker compose down
docker ps -q --filter label=baskule.managed=true --filter label=baskule.instance="<instance>" | xargs -r docker stop
umask 077
docker compose run --rm -T backup > backup.tar.gz
```

Save the archive, compose file, and optional `.env` off the machine. The archive includes generated secrets,
local RustFS and every host `baskule-space-*` disk labeled `baskule.managed=true` and
`baskule.instance=$COMPUTERD_INSTANCE`. Compose defaults the instance to its project name;
keep that name (or an explicit `COMPUTERD_INSTANCE`) unchanged on restore. Node caches are
disposable. Snapshot external S3 separately while services are stopped. Protect backups like credentials.
Start again with `docker compose up -d`.

To restore, place the saved compose file and optional `.env` in a directory whose destination volumes are empty.
Restore external S3 first if used, then run:

```sh
docker compose run --rm -T restore < backup.tar.gz
docker compose up -d
```

Restore refuses nonempty platform volumes and any existing destination disk name. It recreates
disks with their original names and labels and preserves numeric owners, modes and symlinks.
Stop computer containers as well as Compose services before backup; they are managed outside Compose.
Backup and restore mount the Docker socket read-only, which still grants Docker API administration.
They use temporary network-disabled containers, removed on exit, and temporary local archive space
large enough for all disks. Only standard local Docker volumes are supported for restore.
This archive format requires the matching release's restore command. Files under `/sandbox/space` persist;
other computer files are temporary. Restore the same release before updating.

## Update

Read release notes for migrations and the declared client/server compatibility window. Back up first and keep
the old compose file with the backup. Release notes list changes that cannot migrate existing data, with the affected data and deployment steps. Follow them before updating.

For 0.5.1 and earlier, under `baskule-rustfs`, change `mem_limit: 1g` to `mem_limit: 2g` in the downloaded
Compose file. Re-downloading those versions resets this edit. Apply it again before `docker compose up -d`.

```sh
curl -fLO https://github.com/baskule/baskule/releases/latest/download/docker-compose.yml
docker compose up -d --remove-orphans
```

The compose file selects the released version. Keep your optional `.env`; no version edit or secret regeneration
is needed. Updates can interrupt chats and commands. Check sign-in and a computer command after reconnecting.
`docker compose down` stops services and retains data. `docker compose down -v` deletes Compose volumes and secrets.
Computers and their disks are separate: in a source checkout, `deploy/down.sh --purge` also removes
this installation’s labeled computer containers, disks, and computers network. Use the same
Compose project name and `COMPUTERD_INSTANCE` as the installation. External S3 is not deleted by Compose.
To wipe the installation, preserve backups, remove the volumes, empty external S3 if used, then start the new
release with a fresh setup link.

## Upgrade from 0.5.0

The update command's `--remove-orphans` removes the privileged OpenShell service and its computers before disk migration.
Keep the `baskule-openshell-docker` Compose volume until every space disk has migrated and its files are verified.
`COMPUTER_LEGACY_VOLUME` selects this volume; Compose supplies its project-prefixed name. On first ensure, a
network-disabled helper copies `volumes/baskule-space-<suffix>/_data` to the host disk and writes `.baskule-migrated`.

Backups include migrated computer disks and unmigrated legacy disks. Backup and restore jobs must use the same
`COMPUTER_LEGACY_VOLUME` as computerd. Restore recreates that store for lazy migration and refuses an existing
legacy volume. Compose does not mount it, so `docker compose down -v` retains it. Keep a backup and delete the
volume only after verifying every migrated disk, or as part of a full installation wipe.

## Troubleshooting

- `docker compose ps -a` shows health and one-shot exit status.
- `docker compose logs setup baskule-bootstrap baskule-deploy` shows setup, storage, and deployment failures.
- `docker compose logs baskule-celld-a baskule-celld-b` shows platform errors.
- `docker compose logs baskule-computerd` shows computer startup errors.
- A new platform node cannot become healthy before the first deployment. Check the deploy job and S3 first.
- A GHCR permission error can come from stale credentials. Run `docker logout ghcr.io`, then retry the pull.

For optional traces, set `COMPOSE_PROFILES=traces`, `BASKULE_CELLD_OTEL=http://baskule-traces:4318`,
`BASKULE_OTLP_TRACES_URL=http://baskule-traces:4318/v1/traces` in `.env`. The trace UI defaults to `127.0.0.1:47098`;
`BASKULE_TRACES_BIND` and `BASKULE_TRACES_PORT` change it independently of the edge. Restarting it clears traces.
Starting with `--profile '*'` is unsupported: it also starts the edge inheritance templates. Use named profiles such as `traces`.

## Idle Space eviction

The default is 900 seconds, as decided under
[#87](https://github.com/baskule/baskule/issues/87). Helm exposes
`celld.idleEvictSeconds`. Compose reads `CELLD_IDLE_EVICT_S` from `deploy/.env` or
the environment, and the worktree stack accepts the same variable through the
shell, a profile, or `scripts/stack up --set CELLD_IDLE_EVICT_S=900`.

Positive values configure celld's idle-eviction age in seconds. Set the Helm value
or Compose/stack setting to `0` to disable idle eviction. Helm omits the native
variable, and the Compose and local celld launchers remove it before starting celld,
because the native parser accepts only positive seconds or an absent variable.

**Upgrade choice:** previous shipped configurations left idle eviction disabled.
A plain Helm upgrade adopts the new default and enables eviction after 15 minutes.
With `helm upgrade --reuse-values`, Helm reuses the previous release's values;
if `celld.idleEvictSeconds` was absent, it stays absent and eviction stays disabled.
Set `--set celld.idleEvictSeconds=900` to opt in explicitly, or `0` to disable it.
With `--reset-values`, Helm adopts the new defaults, including 900 seconds.
Compose adopts its default unless the operator overrides `CELLD_IDLE_EVICT_S`.
Before upgrading, the installation operator must choose whether to enable this
behavior, select another positive age, or preserve disabled eviction with an explicit
`0`. Existing installations opt in during their authorized rollout; choose explicitly
instead of relying on how the upgrade command merges values.
Apply the chosen setting consistently to every node during an authorized rollout.

Eviction frees idle Spaces' per-cell memory and open database connections. A retained
isolate reuses the evaluated application graph; a fresh heap must compile and
evaluate it again. Pressure eviction retains no heap. The
[runtime patch guide](celld-runtime-patch.md#bounded-cell-isolate-retention)
defines retention eligibility and its memory bounds. Timing results belong in the
pull requests' verification evidence.
