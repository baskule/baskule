# Install Baskule

This guide installs Baskule on one machine. That is enough to try it and to serve a team of a few people. It is
written so that a person or a coding agent can follow it from top to bottom.

The installation builds Baskule from source inside a pinned build container, then starts it with Docker Compose.
Prebuilt images and a one-command installer are coming.

## What you need

- One machine running **Ubuntu 24.04 on x86-64**. A physical server, a spare desktop or a cloud VM all work.
- **Docker** with the Compose plugin, and `git`.
- **4 CPU cores, 16 GB of memory and 80 GB of free disk** for a first try. Each agent computer uses up to 2 CPU
  cores and 3 GB of memory while it runs, so add capacity for the number of people working at the same time.
- An **AI provider key** (Mistral, OpenAI, Anthropic or any OpenAI-compatible endpoint), or none at all if you start
  with the free OpenCode model.
- Root access (`sudo`). The installation lives in `/opt/baskule`.

The first build compiles the sandbox runtime in Rust and can take 30 to 60 minutes. Later builds reuse their
caches and take a few minutes.

## 1. Get the source

```sh
sudo install -d -m 700 /opt/baskule /opt/baskule/cache
sudo git clone https://github.com/baskule/baskule /opt/baskule/src
```

## 2. Configure the installation

```sh
cd /opt/baskule/src/deploy/v2
sudo ./init-env.sh
sudo nano .env
```

`init-env.sh` writes `.env` with fresh random secrets. Keep it private: it is readable only by root and stays out
of Git. Set at least these values:

| Setting | Value |
| --- | --- |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first administrator. The password is only used at first start. |
| `BASKULE02_BIND` | `127.0.0.1` to use Baskule from this machine only, or the machine's private network address (for example its LAN or Tailscale address) so other people can reach it |
| `PUBLIC_ORIGINS` | The exact address people will open, for example `http://192.168.1.20:47090` or `https://baskule.example.com` |

Leave the other values as they are for a first installation. Sign-in uses passwords by default
(`deploy/v2/auth.json`); [single sign-on](#sign-in-with-google-microsoft-or-your-company-account) can be added later.

## 3. Build and start

```sh
cd /opt/baskule/src
sudo docker build --network=host -t baskule-build deploy/v2/build-env
sudo docker run --rm --name baskule-build --network=host --pid=host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/baskule:/opt/baskule -w /opt/baskule/src baskule-build
```

The build container installs the dependencies, builds the web app, the agent platform and the four service images,
starts everything and deploys the app. It ends by printing the address, by default `http://127.0.0.1:47090/`.

Check that it is up:

```sh
curl -s http://127.0.0.1:47090/version.json
```

## 4. Finish the setup in the app

1. Open the address and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
2. Open **Admin → AI → Models**. Choose a provider, paste its key and pick a model. Baskule checks the key and the
   model before saving.
3. Open **Admin → General → Organization** to name your organization and set how long an idle computer keeps
   running.
4. Invite people from **Admin → People → Invitations**, create team spaces in **Admin → Spaces**, and add plugins in
   **Admin → Plugins**.
5. Remove `ADMIN_PASSWORD` from `.env`, then run the build container again (step 3). Nothing is rebuilt; the app is
   redeployed without the bootstrap password.

## Connect the desktop and mobile apps

The web app works in any modern browser at the installation's address. The desktop and mobile apps connect to an
installation by its address: in the web app, open **Apps → Connect a device** to get a link or a QR code. Native
apps are built from this repository today (see [the desktop guide](../desktop/README.md) and
[the mobile guide](../app/apps/mobile/README.md)); ready-made downloads arrive with the first public release.

## Make it reachable by your team

- **On a private network**, set `BASKULE02_BIND` to the machine's private address and `PUBLIC_ORIGINS` to the URL
  people use, then run the build container again.
- **Over the internet**, put an HTTPS reverse proxy in front of port 47090 and set `publicOrigin` in `auth.json` to
  your HTTPS address (for example `https://baskule.example.com`). Never publish port 47090 itself on a public
  interface. Browsers only allow voice input over HTTPS or on `localhost`.

## Sign in with Google, Microsoft or your company account

Add login providers to `deploy/v2/auth.json`: Google, Microsoft, GitHub or any OIDC provider. Admins then control
who can join in **Admin → General → Authentication**. The [installation settings](installation-settings.md) give
complete examples, including Google Workspace domains and plugin accounts that reuse a person's login.

## Use external storage

By default every cell is stored in a RustFS bucket on the machine's disk. To use any S3-compatible bucket instead
(a replicated bucket, or a provider in your own country), set `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY` and `CELLD_BUCKET_NAME` in `.env` before the first start. See
[deploy on a dedicated host](../deploy/v2/contabo.md).

## Back up, update and stop

Run these from `/opt/baskule/src`.

| Task | Command |
| --- | --- |
| Back up everything (bucket, sandbox state, every computer's disk) | `sudo deploy/v2/backup.sh` |
| Update to the latest version | `sudo git -C /opt/baskule/src pull`, then run the build container again (step 3) |
| Stop, keeping all data | `sudo deploy/v2/down.sh` |
| Start again | run the build container again (step 3) |

`deploy/v2/down.sh --purge` deletes **all** data. Back up first. Restoring, rolling upgrades and the other
operations are in the [deployment guide](../deploy/v2/README.md).

## If something goes wrong

- `docker ps` lists the services. Every container name starts with `baskule02-`.
- `docker logs baskule02-celld-a` shows the agent platform, and `docker logs baskule02-computerd` the computers.
- A trace view of every request is published on port 47098 of the bind address.
- [Building from source](building.md) explains the toolchains in detail.
