# Verify released installation assets

Build the backend images from the current source using [the build environment](building.md), with source tag
`:local`. Keep test tags separate from an installation. The source celld image only contains tools; build the
`release` target to include the generated platform bundle, then tag the other two host images:

```sh
source scripts/env.sh
export BASKULE_INSTALL_REGISTRY=ghcr.io/baskule
export BASKULE_INSTALL_VERSION=local
docker build --network host --target release -f deploy/celld/Dockerfile \
  -t "$BASKULE_INSTALL_REGISTRY/baskule-celld:$BASKULE_INSTALL_VERSION" .
for name in computerd openshell-gateway; do
  docker tag "baskule-$name:local" "$BASKULE_INSTALL_REGISTRY/baskule-$name:$BASKULE_INSTALL_VERSION"
done
node e2e/release-install.mjs
```

Choose a different registry prefix or tag with `BASKULE_INSTALL_REGISTRY` and `BASKULE_INSTALL_VERSION`.
Only the three host images need these tags; workload images are bundled in the gateway. These commands do not
push images or contact a model provider.

The driver creates unique Compose projects under `.run/`. The single-machine target uses the default loopback
port 47090; proxy and external-storage targets select free ports. Its single-machine install directory
starts with only the released Compose file. `.env` and a config directory are not required. It runs Compose directly, with no
source-build override. The fake LLM is a separate fixture. Checks cover default password authentication, admin
sign-in, a streamed fake chat, and a shell command through the platform's computerd endpoint. It checks chat and
computer-file persistence after a compose-file version update and down/up, then backs up and restores into empty
volumes. Hashes of every consumer secrets file must match across restart, update, and restore.
The gateway update also checks removal of old workload tags and pruning of a distinct obsolete image.

The cluster simulation gives each role its own network namespace on an isolated Docker LAN. Test-only Compose
network overrides model machine interfaces and avoid the host firewall's bridge-to-host rules. The release node
role uses private host bindings; the override gives each simulated node its own private interface instead. The
computers' gateway stays on its separate private bridge. The S3 bucket and fake model are independent fixtures.
Checks cover two node leases and signed peer probes, chat and computer execution through the edge, and recovery
after killing the owner node. This proves local role wiring, not network behavior or firewall rules across physical machines.

The driver removes its own containers, networks, and volumes in a `finally` block. It never uses `scripts/stack`
or the shared development gateway. Evidence, logs, the backup, and private generated configuration stay under
`.run/`; treat them as private. The release factory runs the driver on its disposable runner before image publishing.

Before submitting a change, also run `scripts/check plan`, its selected checks, `actionlint` on the release
workflow, and Compose configuration checks for all roles and profiles. A verification-only factory run can prove
the full packaging path. Anonymous GHCR pulls, public release downloads, and real multi-machine operation require
separate owner-controlled verification after publication.

Pass `fresh` to run three cold installs into empty volumes, checking first startup, health, version, and
admin sign-in each time. Set `BASKULE_INSTALL_EVIDENCE` to choose an evidence directory.

Pass `single`, `proxy`, `external`, or `cluster` as the driver's last argument to rerun only that target after a classified failure.

The single-machine driver saves private account and thread references in `.run/<run>/single-proof.json`.
To rerun only restoration against the retained archive, pass `restore .run/<run>/single-proof.json` to the driver.
The proof file contains test credentials and is not an uploaded artifact.

The `proxy` target runs a host-local forwarding proxy in front of the released edge, with a custom bind port and no
`PUBLIC_ORIGINS`. It checks the printed link's port, HTTPS setup and Secure cookies, sign-in, foreign Origin refusal,
and independent client rate limits. A separate direct client on the private Docker network must not be able to
spoof forwarded host, scheme, or IP to bypass those checks. Runtime environment and mounted-volume assertions
verify that RustFS, computerd, and OpenShell receive only their own generated secrets and no unrelated `.env` values.
After the admin exists, another `up -d` must add no setup links to the setup or deploy logs.

The `external` target uses an independent S3 fixture while the bundled RustFS exits unsuccessfully. The platform
must deploy, print a setup link, create an admin, and sign in without depending on local storage health.
Both targets run as part of `all`; run them separately while iterating. Single-machine projects pin the platform
network to `172.30.90.0/24`, so run these targets sequentially on a host without another installation on that subnet.
Docker's gateway is the only trusted proxy on this network. Rootless Docker can hide client addresses and needs
outer-proxy access controls and rate limits.

Setup unit checks cover invalid tokens, validation, SSO, duplicate and concurrent submissions, rate limiting, capacity
eviction, and success when automatic sign-in fails. Jobs checks cover consumer secret scopes, idempotence, adding
missing keys, explicit overrides, and conditional setup-link output. Use `scripts/check plan` for focused selections.
