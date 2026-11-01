# Deploy on a dedicated host

This example uses Ubuntu 24.04 amd64, Docker, a private network interface such as Tailscale, and an external
S3-compatible bucket. It contains no credentials or addresses for an existing installation.
See [building from source](../docs/building.md) before building the native OpenShell images.
Automated deployment and public-repository CI are deferred.

## Prepare the host

Install Docker, SSH, and your private network client on a dedicated host. Keep application and trace ports off
the public interface. Docker-published ports bypass ordinary ufw INPUT rules, so apply a DOCKER-USER policy too.
Permit SSH only through your private network or a restricted operator address. Verify access before closing an
existing SSH session.

Use a root-owned checkout at `/opt/baskule/src` and cache directory at `/opt/baskule/cache` when using the
optional build environment or deployment gate. Keep `/opt/baskule` mode 700. The gate expects a read-only
repository deploy key at `/opt/baskule/deploy-key` and verified GitHub host keys at
`/opt/baskule/cache/known_hosts`. Keep private keys mode 600 and outside the checkout.
The canonical repository is `baskule/baskule`.

## Configure the installation

Create `deploy/.env` from `.env.example` with fresh infrastructure secrets. Keep it mode 600 and outside Git.
Set these values for your installation:

- `BASKULE_BIND` to the host's private IPv4 address. The source defaults to `127.0.0.1`.
- `BASKULE_PORT` to the application port, normally `47090`.
- `PUBLIC_ORIGINS` to the exact private URLs clients use, including any hostname aliases.
- `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `CELLD_BUCKET_NAME` for your external bucket.
  Setting `S3_ENDPOINT` selects `docker-compose.s3.yml`. Leave it unset to use local RustFS.
- `COMPUTERD_TOKEN` and `OPENSHELL_VOLUMES_TOKEN` to fresh random secrets.
- Resource limits to values appropriate for your host and expected concurrent computers.
- `AUTH_CONFIG_FILE` to your private installation-authentication JSON file.

For authenticated mode, set first-boot `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Configure login methods using
[installation settings](../docs/installation-settings.md). Anonymous mode makes every visitor an administrator;
keep such an installation restricted to trusted users on a private network. Remove the bootstrap password after
the administrator exists and redeploy.

## Build and operate the stack

From the reviewed checkout, run `deploy/build.sh --no-deploy` to build without replacing a running stack.
Run `deploy/up.sh` to start a new installation, or `deploy/build.sh` to build and deploy an intentional update.
Check the served `/version.json` against the expected source, then open `/.well-known/baskule` to check the
installation authentication mode. Configure the organization's AI connection through Admin settings.

Use [the stack operations guide](README.md#operate) for backup, restore, and upgrades.
An external bucket holds cell data outside Docker volumes. `down.sh --purge` empties that configured bucket
as well as deleting the installation's volumes. Back up the installation before any intentional wipe.

If you run deployed-stack checks, select one required area from the
[development workflow](../docs/development-workflow.md). They can change AI settings, create fixtures, and
restart services. Use the fake LLM unless real-model checks are explicitly requested.

## Optional runners

The retained [runner setup tools](runner/README.md) require explicit staging addresses and root-owned isolation
policies. Set `BASKULE_STAGING_PUBLIC_IP` when installing their host policies. A future CI boundary job must
receive `BASKULE_STAGING_ADDRESS` and, if necessary, `BASKULE_STAGING_PORT`.
These settings are operator configuration, not committed host defaults.

Persistent self-hosted workers are unsuitable for arbitrary public contributions without disposable workers or
equivalent job isolation. Configure CI only after reviewing that separation. No workflow is enabled by this guide.

## Desktop and mobile releases

Desktop and mobile packaging automation is deferred. Follow [the desktop build instructions](../desktop/README.md)
and [building from source](../docs/building.md) for current local builds.
A future release job must build the exact version tag with matching platform toolchains and private signing
credentials, publish checksums, and explicitly stage artifacts under `/downloads/`.
Hosted application deployments with `DOWNLOADS=0` do not build or sign native packages.
