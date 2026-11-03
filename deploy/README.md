# Deployment assets

Operators use [Install Baskule](../docs/install.md) or [Install on Kubernetes](../docs/install-kubernetes.md).
Developers use [Build Baskule](../docs/building.md). The Helm chart is the only cluster install; Compose serves single-machine installs.

| File | Purpose |
| --- | --- |
| `docker-compose.yml`, `.env.example` | Standalone single-machine release assets |
| `helm/baskule/` | Kubernetes cluster chart |
| `docker-compose.build.yml` | Source-build override, selected by `lib.sh` |
| `celld/` | Shared node/job image containing Worker, web app and deployment utilities |
| `build-env/` | Ubuntu 24.04 native build environment |

Compose runs computerd against the host Docker socket, as user `node`. Set `DOCKER_GID`
to `stat -c %g /var/run/docker.sock` (default 999) so it can access the socket.
This grants Docker administration privileges. Computers use the separate
`COMPUTER_NETWORK` bridge (default `baskule-computers`), created by computerd.
The guard helper uses the computerd image with NET_ADMIN in the host network namespace;
Docker must provide the iptables DOCKER-USER chain. It denies private and host destinations.
`COMPUTER_DNS` optionally selects comma-separated public DNS IPs.
Each computer defaults to 2 CPUs and 3 GiB. The computer and computerd images must
already be available on the host. There is no OpenShell service.
The old `baskule-openshell-docker` volume declaration is retained for the upcoming data migration.

`up.sh`, `deploy.sh`, `down.sh`, and `recreate-computers.sh` serve the checkout-based
developer path. For a source-stack backup, source `deploy/lib.sh` and run
`dc --profile backup run --rm -T backup > backup.tar.gz` with the stack stopped. Operators need only the release files and Docker Compose. Release assembly uses
`scripts/release-install-assets.sh`; CI and publishing are documented in [Hosted checks and artifact builds](../docs/ci.md).

The bootstrap job generates per-consumer secrets in separate named volumes. After deployment, the one-shot
`setup` service prints `/setup#token=…` only when the API reports that setup is required.
Create the first admin through that link. Once an admin exists, the token cannot create another.

Start only named profiles such as `traces`; `docker compose --profile '*' up` is unsupported because it also starts
the edge inheritance templates. `BASKULE_EDGE` accepts lowercase `http` or `https`; HTTPS requires `BASKULE_DOMAIN`.
