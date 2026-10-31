# Install Baskule

This guide runs Baskule on one Linux x86-64 machine with Docker Compose. You download released images and two
configuration files. No checkout, compiler, or build container is needed. For several machines, use the
[cluster guide](install-cluster.md).

## Requirements

- Docker Engine with Compose **2.24.4 or newer**, and curl. Your account must be able to run Docker.
- Start with **4 CPU cores, 24 GiB RAM, and 80 GB free disk**. Allow more disk for conversations and computer files.
  The default memory caps total 15.75 GiB: two platform nodes at 3 GiB each, storage at 1 GiB, edge at 256 MiB,
  computerd at 512 MiB, and all computers together at 8 GiB. The remaining memory is for Docker and the OS.
  CPU caps total 10 cores but are limits, not reservations. Use more cores for concurrent work.
- A private address or an HTTPS reverse proxy for team access.

OpenShell runs a privileged container with its own Docker daemon. It does not mount the host Docker socket.
Each computer is limited to 2 cores and 3 GiB by default, within the shared OpenShell cap. Use a dedicated machine
for untrusted workloads. An AI connection is configured in the app after sign-in.

## Download and configure

Choose a version from [Releases](https://github.com/baskule/baskule/releases), then run:

```sh
mkdir baskule && cd baskule
VERSION=0.5.0
ASSETS=https://github.com/baskule/baskule/releases/download/v$VERSION
curl -fLO "$ASSETS/docker-compose.yml"
curl -fL "$ASSETS/baskule.env.example" -o .env.example
umask 077
docker run --rm -i --network none --entrypoint baskule-celld-job \
  "${BASKULE_REGISTRY:-ghcr.io/baskule}/baskule-celld:$VERSION" init-env - < .env.example > .env
chmod 600 .env
```

Edit `.env`. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PUBLIC_ORIGINS`, and `BASKULE_BIND`:

- For this machine only, keep `BASKULE_BIND=127.0.0.1` and `PUBLIC_ORIGINS=http://127.0.0.1:47090`.
- For a private network, bind its private address and set `PUBLIC_ORIGINS` to the exact URL people open.
- For HTTPS, follow [the reverse proxy setup below](#https-and-reverse-proxies).

The initializer generates the storage, computerd, and volume-helper secrets. Keep them and `.env` private.
Passwords can be single-quoted in `.env` so Compose preserves special characters. Keep the same Compose project
name and directory for later commands. `-p NAME` or `COMPOSE_PROJECT_NAME` selects an independent installation.

## Start and sign in

```sh
docker compose up -d
docker compose ps -a
curl -fsS http://127.0.0.1:47090/version.json
```

Use your configured bind address and port for curl. The bootstrap and deploy services finish with exit code 0;
the two platform nodes and OpenShell become healthy. The edge waits for deployment before serving requests.
The gateway loads the bundled computer, supervisor, and sandbox images into its private daemon on first start.
This import can take several minutes; Compose waits for it.

Open `PUBLIC_ORIGINS` in a browser and sign in with the first administrator's email and password. In
**Admin → AI → Models**, choose a provider and model. Configure the organization, invite people, and create team
spaces in the admin area. See [installation settings](installation-settings.md) for the available settings.

Clear `ADMIN_PASSWORD` in `.env`, then run `docker compose up -d` again. This redeploys without the bootstrap
password. Existing accounts and settings are stored in the bucket.

## HTTPS and reverse proxies

Terminate HTTPS at your reverse proxy and forward to `BASKULE_BIND:BASKULE_PORT`. Keep that port on loopback
or a private interface. Forward WebSockets and streaming responses without buffering. With Caddy on the host:

```caddyfile
baskule.example.com {
    reverse_proxy 127.0.0.1:47090
}
```

Set `PUBLIC_ORIGINS=https://baskule.example.com` and add this line to `.env`, then run `docker compose up -d`:

```dotenv
AUTH_CONFIG='{"version":1,"password":true,"publicOrigin":"https://baskule.example.com"}'
```

`publicOrigin` selects callback URLs and Secure cookies. `PUBLIC_ORIGINS` allows requests from that origin.
Browsers require HTTPS or localhost for microphone access. Publish only your HTTPS proxy, never the platform,
storage, computerd, or OpenShell ports.

## Single sign-on

Password sign-in is the default when authentication configuration is absent. No `auth.json` is required.
For SSO, put the authentication JSON in the single-quoted `AUTH_CONFIG` value in `.env`; it can refer to other
`.env` secrets using `{"env":"NAME"}`. Follow [installation settings](installation-settings.md#authentication-file)
for providers and callback addresses. Run `docker compose up -d` after changing it. An invalid configuration
fails deployment. You can instead save it as `config/auth.json`; that optional file takes precedence over
`AUTH_CONFIG`. Compose creates the empty `config` directory on first start. Keep the file private and run
`docker compose run --rm --no-deps baskule-deploy` after editing it. Back up before switching authentication modes,
which requires a fresh bucket.

## External storage

Before the first start, set `COMPOSE_PROFILES=` to disable local storage. Set `S3_ENDPOINT`, `S3_REGION`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `CELLD_BUCKET_NAME` to a private S3-compatible bucket and its credentials.
The bucket must support the conditional writes and consistency required by celld. The bootstrap job checks the
bucket and creates it if absent; pre-create it when credentials do not permit bucket creation.

The bucket contains accounts, organization settings, chats, attachments, and cell state. Changing buckets selects
a different installation. Computers and gateway keys remain on this machine. External storage needs its own backup.

## Backup and restore

Run from the installation directory. Stop all services before copying state:

```sh
docker compose down
umask 077
docker compose run --rm -T backup > backup.tar.gz
```

Copy the archive, `.env`, and any `config/auth.json` off the machine. The archive contains local RustFS, gateway state and keys, and the
whole private Docker store, including computer disks and cached images. It can be large. Node caches are disposable.
An external bucket is excluded; snapshot it separately while the stack is stopped. Protect backups like credentials.
Start again with `docker compose up -d`.

To restore, put the same release assets, saved `.env`, and optional authentication file in an installation directory with **empty volumes**.
Restore an external bucket first if used, then run:

```sh
docker compose run --rm -T restore < backup.tar.gz
docker compose up -d
```

The restore job refuses nonempty destination volumes. Restored computers are recreated through OpenShell to
re-admit their disks. Persistent files under `/sandbox/space` remain; other container files are temporary. Use the same release for restore before updating.
Deleting volumes destroys the installation's local data; do so only after preserving a backup.

## Update and stop

Read the target release's notes for any required alpha data wipe. Back up first. Download its `docker-compose.yml`
and env example with the commands above, retain your private `.env`, and set `BASKULE_VERSION` to the new tag.
Compare the new example for configuration changes, then run:

```sh
docker compose pull
docker compose up -d
```

The new platform bundle deploys to both nodes. OpenShell restarts computers; their persistent disks remain.
Updates can interrupt chats, commands, and WebSockets. Reconnect after the services become healthy. Keep the old
assets and backup until you have checked `/version.json`, sign-in, and a computer command.

`docker compose down` stops Baskule and keeps data. `docker compose up -d` starts it again.
`docker compose down -v` deletes all Compose volumes, including local accounts, chats, and computer disks.
It does not delete an external bucket. If release notes require a wipe, stop the stack, preserve the backup,
remove those volumes, empty the external bucket if used, and start with the new assets and bootstrap admin values.

## Troubleshooting

- `docker compose ps -a` shows health and one-shot exit status.
- `docker compose logs baskule-bootstrap baskule-deploy` shows storage or deployment failures.
- `docker compose logs baskule-celld-a baskule-celld-b` shows platform errors.
- `docker compose logs baskule-computerd baskule-openshell` shows computer startup errors.
- If the edge is not running, first check the deploy job and S3 credentials. A fresh node cannot be healthy before
  its first app deployment.
- A GHCR permission error means the release packages are not public or your Docker account cannot read them.
- Check that the configured bind address exists and the port is free before changing it.

Traces are optional. To use the bundled in-memory collector, set `COMPOSE_PROFILES=storage,traces` and enable the
three exporters shown in `.env.example`. With external S3 use `COMPOSE_PROFILES=traces`. The trace UI is on the
configured bind address at port 47098. A restart clears traces. You can instead point the exporters at your own collector.
