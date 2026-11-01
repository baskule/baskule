# Install a Baskule cluster

A cluster runs platform nodes on several machines and keeps their cell state in one external S3-compatible bucket.
The computers run on one separate host. Use the [single-machine guide](install.md) for a smaller installation.
All machines need Linux x86-64 and Docker Engine 25 or newer with Compose 2.24.4 or newer. The setup commands also use OpenSSL.
No source checkout or build is needed.

## Roles and network

```text
clients → HTTPS load balancer → platform nodes → external S3 bucket
                                    │
                                    └→ computerd → OpenShell → computers
```

Each platform machine runs one celld node from the same release image. Nodes find each other through the bucket,
and any node can serve a request by forwarding it to the node that owns the cell. One computers host runs computerd
and OpenShell. Computers are sandboxed and cannot reach private addresses.

**Put all machines on one private network**, such as a cloud VPC or a VLAN. If they can only reach each other over
the internet, connect them with WireGuard or Tailscale first and use those addresses below. Traffic between the
roles, including the computerd token, is plain HTTP and must stay on that network. Each role listens only on the
private address you set as `BASKULE_PRIVATE_IP`; only your HTTPS load balancer faces clients.

| Port | Listener | Reached by |
| --- | --- | --- |
| 443 | Your HTTPS load balancer | Clients |
| 47090 | Bundled edge (optional) | Your HTTPS proxy |
| 47091 | Worker on each platform node | Load balancer or edge; computers host |
| 47092 | Peer port on each platform node | Platform nodes only |
| 47094 | computerd on the computers host | Platform nodes |
| S3 endpoint | Your bucket | Platform nodes only |

Then add two firewall rules:

- [ ] Port 47092 on every platform node accepts only the platform nodes. It is an unauthenticated operator API.
- [ ] The computers host cannot reach port 47092 on any node, nor the S3 endpoint. A rule that allows the whole
      private subnet would let it.

Allow platform nodes 2 cores and 3 GiB RAM each, plus OS memory and cache disk. The computers host's default cap
is 3 cores and 8 GiB for OpenShell plus 1 core and 512 MiB for computerd. Start that host with at least 4 cores,
12 GiB RAM, and 80 GB free disk. Increase limits for more concurrent computers. The edge is capped at 1 core and
256 MiB. These are limits, not reserved capacity.

## Prepare the bucket

Create one private S3-compatible bucket with the conditional-write and consistency semantics celld requires.
Give every platform node and the deploy job access to that same bucket. Keep its endpoint, region, bucket name,
and credentials identical across nodes. Local storage on a platform machine cannot replace the shared bucket.
Keep the bucket on a reliable storage service and arrange backups there.

The examples below use private addresses `10.0.0.11` and `.12` for platform nodes and `10.0.0.20` for computers.
Replace them with your own addresses. Choose a published release and use its version on every machine.

## Set up the computers host

Create an installation directory on the computers machine and download its role assets:

```sh
mkdir baskule-computers && cd baskule-computers
VERSION=0.5.0
ASSETS=https://github.com/baskule/baskule/releases/download/v$VERSION
curl -fL "$ASSETS/cluster-computers.yml" -o docker-compose.yml
curl -fL "$ASSETS/cluster-computers.env.example" -o .env.example
umask 077
sed '/^COMPUTERD_TOKEN=/d; /^OPENSHELL_VOLUMES_TOKEN=/d' .env.example > .env
printf '\nCOMPUTERD_TOKEN=%s\nOPENSHELL_VOLUMES_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
chmod 600 .env
```

Set `BASKULE_PRIVATE_IP` to this host's private address and `PLATFORM_URL` to a reachable platform Worker or private
edge URL. Computerd reads the organization idle policy there. Keep the generated `COMPUTERD_TOKEN` and
`OPENSHELL_VOLUMES_TOKEN`. Copy only `COMPUTERD_TOKEN` to the platform deployment configuration.

```sh
docker compose up -d
docker compose ps -a
```

OpenShell loads the computer and runtime images from the gateway image. Computerd can start before platform nodes;
settings requests begin to succeed once the app is deployed.

## Set up each platform node

On each platform machine:

```sh
mkdir baskule-node && cd baskule-node
mkdir config
VERSION=0.5.0
ASSETS=https://github.com/baskule/baskule/releases/download/v$VERSION
curl -fL "$ASSETS/cluster-node.yml" -o docker-compose.yml
curl -fL "$ASSETS/cluster-node.env.example" -o .env.example
umask 077
cp .env.example .env
chmod 600 .env
```

Set a unique, stable `CELLD_NODE` and this machine's `BASKULE_PRIVATE_IP`. Each node binds Worker port 47091 and
peer port 47092 there, and advertises `<private-ip>:47092`. Fill the external S3 values. Set `COMPUTERD_URL` to
`http://10.0.0.20:47094` and `COMPUTERD_TOKEN` to the computers host's token.

In the configuration used for app deployment, set `CELLD_NODES_INTERNAL` to every platform node's private peer
address, separated by spaces. Set `PUBLIC_ORIGINS` and `AUTH_CONFIG.publicOrigin` to the public HTTPS URL. Set the
`SETUP_TOKEN` to a token generated with `openssl rand -hex 32`, and `PUBLIC_URL` to the public HTTPS URL. Keep this app configuration consistent if several operators deploy.

Start the node on each machine, then deploy the app **once**, from one platform machine:

```sh
docker compose up -d
docker compose run --rm deploy
```

A new node becomes healthy after the first deployment. Check `docker compose ps` on each machine. To inspect
membership without changing the bucket:

```sh
docker compose exec node sh -c 'celld diagnose --read-only --json --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT"'
```

All configured nodes must have valid leases and reachable peers. Do not publish diagnostic output containing
private addresses or bucket details.

## Set up the edge

With your own HTTPS load balancer, list every private Worker endpoint, such as `10.0.0.11:47091` and
`10.0.0.12:47091`. Use `/.well-known/celld/health` for health checks. Support WebSockets and streaming responses
without buffering, forward the client address, and retry a different node after a failed connection.

For the bundled HTTP Caddy edge, on its machine:

```sh
mkdir baskule-edge && cd baskule-edge
VERSION=0.5.0
ASSETS=https://github.com/baskule/baskule/releases/download/v$VERSION
curl -fL "$ASSETS/cluster-edge.yml" -o docker-compose.yml
curl -fL "$ASSETS/cluster-edge.env.example" -o .env
```

Set `BASKULE_NODES_WORKER` to every private Worker address, separated by spaces, and `BASKULE_BIND` to loopback for
a proxy on the same machine or to this machine's private address for a separate proxy. Run `docker compose up -d`.
The edge serves plain HTTP, retries a failed node and checks node health; it obtains no certificates. Put your HTTPS
reverse proxy in front of it and set `BASKULE_TRUSTED_PROXIES` as described in
[your own reverse proxy](install.md#your-own-reverse-proxy). Without trusted proxies, set `PUBLIC_ORIGINS` in the
platform nodes' `.env` to the public HTTPS origin.

Open the setup link printed by `docker compose run --rm deploy` to create the first admin. The token becomes
useless after setup. Configure **Admin → AI → Models** and invite people. For SSO, set `AUTH_CONFIG` or save the optional `config/auth.json` on the machine running the deploy job. Use
[installation settings](installation-settings.md#authentication-file). Traces are off unless the optional OTLP
variables in each role's env example point to a reachable collector.

## Add or remove a platform node

To add a node, install the same release, give it a unique `CELLD_NODE`, and point it at the same bucket and private
network. Start it and wait for its health route. Add it to the load balancer and `CELLD_NODES_INTERNAL` before the
next app deployment. For bundled Caddy, edit `BASKULE_NODES_WORKER` and run `docker compose up -d`.

To remove a node, first remove its Worker endpoint from the load balancer. Run `docker compose down` on that
machine. Celld has up to 40 seconds for graceful cell handoff; Compose allows 50 seconds. Remove the address from
`CELLD_NODES_INTERNAL`. Keep at least one healthy node throughout. Node cache volumes can be discarded after a
successful handoff; cell data remains in the bucket.

## Failover and limits

After a node stops, the edge routes Worker requests to healthy nodes. Cells on the failed node become available
on surviving nodes after their leases expire. In-flight requests and WebSockets can fail during takeover;
clients reconnect. A shared bucket outage prevents cell access even when nodes remain healthy.

The platform currently has **one computerd endpoint**. All computers run on one host. Losing it interrupts computer
commands and agent work; platform access can remain available. There is no automatic computers-host failover,
computer scheduling across hosts, multi-region deployment, or automatic bucket replication. A single bundled
edge is also a single point of failure; use your own redundant HTTPS load balancer when needed.

## Back up, update, and stop

For a consistent backup, stop platform nodes and the computers role, then snapshot the external bucket. On the
computers host, run `umask 077`, then `docker compose run --rm -T backup > computers.tar.gz`. Save that archive and each role's
private `.env` and optional `config/auth.json` off the machines. Restore the bucket first, restore the computers archive into empty volumes with
`docker compose run --rm -T restore < computers.tar.gz`, then start the roles. Restore recreates computer
containers to re-admit their persistent disks; files under `/sandbox/space` remain. Node caches can be recreated.

Read the new release notes and back up before updating, keeping each role's current `docker-compose.yml` with the
backup. On each machine, download only that role's new compose file and env example. Keep the existing `.env`: do
not rerun the setup steps above, which would replace it and its secrets (a new `COMPUTERD_TOKEN` locks every node
out of computerd). For example, on a platform node (use `cluster-computers` or `cluster-edge` on the other roles):

```sh
VERSION=0.5.0 # Set the target release.
ASSETS=https://github.com/baskule/baskule/releases/download/v$VERSION
curl -fL "$ASSETS/cluster-node.yml" -o docker-compose.yml
curl -fL "$ASSETS/cluster-node.env.example" -o .env.example
```

Compare the new example for configuration changes, then set `BASKULE_VERSION` in the existing `.env` of each
image-based role (replace any `+` with `_` for Docker tags). For platform nodes, run `docker compose pull`
and `docker compose up -d` **one node at a time**. Wait for each node to be healthy before the next. Once all nodes
run the new image, run `docker compose run --rm deploy` once to publish its bundled app to the fleet.
Update the computers role and edge with `docker compose pull && docker compose up -d`. Computers restart with
persistent disks; commands can be interrupted. Update the load balancer's node list if membership changed.

If release notes require an alpha data wipe, stop all roles, preserve backups, remove their volumes with
`docker compose down -v`, empty the external bucket, then start the new release and create the first admin with the setup link.
Do not use a rolling update for a release that requires a wipe. `docker compose down` alone keeps local state.
