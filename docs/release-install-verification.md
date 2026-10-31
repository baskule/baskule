# Verify released installation assets

Build the six backend images from the current source using [the build environment](building.md). Keep their tags
separate from an installation. Run the operator verification against those local images:

```sh
source scripts/env.sh
BASKULE_INSTALL_VERSION=local node e2e/release-install.mjs
```

The default image names are `ghcr.io/baskule/baskule-NAME:local`. Set `BASKULE_INSTALL_REGISTRY` and
`BASKULE_INSTALL_VERSION` to select another registry prefix and tag. Tag the built images locally first. This
command does not push images or contact a model provider.

The driver creates unique Compose projects and free ports under `.run/`. Its single-machine install directory
contains only the released Compose file, env example, and generated `.env`. It runs Compose directly, with no
source-build override. The fake LLM is a separate fixture. Checks cover default password authentication, admin
sign-in, a streamed fake chat, and a shell command through the platform's computerd endpoint. It checks chat and
computer-file persistence after down/up, then backs up and restores into empty volumes.

The cluster simulation uses two independent node projects, one computers project, a Caddy edge project, and an
independent RustFS bucket. It binds test ports on the host's private IPv4 interface to simulate role-to-role
traffic. It verifies two node leases and peer probes, chat and computer execution through the edge, and cell
recovery after killing the owner node. This proves local role wiring, not network behavior across physical machines.

The driver removes its own containers, networks, and volumes in a `finally` block. It never uses `scripts/stack`
or the shared development gateway. Evidence, logs, the backup, and private generated configuration stay under
`.run/`; treat them as private. The release factory runs the driver on its disposable runner before image publishing.

Before submitting a change, also run `scripts/check plan`, its selected checks, `actionlint` on the release
workflow, and Compose configuration checks for all roles and profiles. A verification-only factory run can prove
the full packaging path. Anonymous GHCR pulls, public release downloads, and real multi-machine operation require
separate owner-controlled verification after publication.

Pass `single` or `cluster` as the driver's last argument to rerun only that target after a classified failure.
