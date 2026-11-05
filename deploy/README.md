# Deployment assets

Operators use [Install Baskule](../docs/install.md) or [Install on Kubernetes](../docs/install-kubernetes.md).
Developers use [Build Baskule](../docs/building.md). The Helm chart is the only cluster install; Compose serves single-machine installs.

| File | Purpose |
| --- | --- |
| `docker-compose.yml`, `.env.example` | Standalone single-machine release assets |
| `helm/baskule/` | Kubernetes cluster chart |
| `docker-compose.build.yml` | Source-build override, selected by `lib.sh` |
| `celld/` | Shared node/job image containing Worker, web app and deployment utilities |

Compose runs computerd against the host Docker socket as user `node`. Its entrypoint
discovers the socket group and drops privileges with that supplementary group.
This grants Docker administration privileges. Computers use the separate
`COMPUTER_NETWORK` bridge (default `${COMPOSE_PROJECT_NAME}-computers`), created by computerd.
The guard helper uses the computerd image with NET_ADMIN in the host network namespace;
Docker must provide the iptables DOCKER-USER chain. It denies private and host destinations and fails closed if verification fails.
FORWARD mirrors prevent earlier accepts from bypassing the guard; nftables-only Docker is unsupported.
`COMPUTER_DNS` optionally selects comma-separated public DNS IPs.
Each computer defaults to 2 CPUs and 3 GiB. Release installs pull the computer and computerd images; Compose uses the pull-only `baskule-computer-image` service for the computer image.
The old `baskule-openshell-docker` volume supplies the 0.5.0 forward data migration.

`up.sh`, `deploy.sh`, and `down.sh` serve the checkout-based
developer path. For a source-stack backup, source `deploy/lib.sh` and run
`dc --profile backup run --rm -T backup > backup.tar.gz` with the stack stopped. Operators need only the release files and Docker Compose. Release assembly uses
`scripts/release-install-assets.sh`; CI and publishing are documented in [Hosted checks and artifact builds](../docs/ci.md).

The bootstrap job generates per-consumer secrets in separate named volumes. After deployment, the one-shot
`setup` service prints `/setup#token=…` only when the API reports that setup is required.
Create the first admin through that link. Once an admin exists, the token cannot create another.

Start only named profiles such as `traces`; `docker compose --profile '*' up` is unsupported because it also starts
the edge inheritance templates. `BASKULE_EDGE` accepts lowercase `http` or `https`; HTTPS requires `BASKULE_DOMAIN`.

Backup/restore use `celld/backup.sh` through the real job entrypoint. They retain platform secrets
and RustFS, and discover host computer disks by `baskule.managed=true` plus `baskule.instance`.
Compose passes `COMPUTERD_INSTANCE` (default: project name) to computerd and both jobs;
new and migrated disks already receive these labels from computerd. Preserve that identity
on restore. Stop both the stack and its independently managed computers for a consistent copy.
The read-only socket bind still permits Docker API writes: temporary containers mount selected
disks with networking disabled, and are deleted on exit. Archives preserve disk names, all labels,
numeric owners, modes and symlinks. Restore requires absent disk names and empty platform volumes.
Unmigrated legacy disks are included. See the install guide for archive storage requirements.

Compose no longer mounts the legacy volume, so `docker compose down -v` keeps it. Delete it only after every space has migrated and its files have been verified, with a backup retained, or during an explicitly authorized full purge.
