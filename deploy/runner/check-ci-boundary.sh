#!/usr/bin/env bash
# Run inside a CI job, never through root or an operator's shell.
set -euo pipefail
: "${BASKULE_STAGING_ADDRESS:?set the actual staging IPv4 address for the boundary check}"
[ "$(id -un)" = ghrunner ]
[ "${DOCKER_HOST:-}" = "unix:///run/user/$(id -u)/docker.sock" ]
if id -nG | tr ' ' '\n' | grep -qx docker; then
  echo '::error::CI still has the host Docker group'; exit 1
fi
if test -x /opt/baskule || sudo -n /usr/bin/true 2>/dev/null; then
  echo '::error::CI can access the root checkout or sudo'; exit 1
fi
if docker --host=unix:///var/run/docker.sock info >/dev/null 2>&1; then
  echo '::error::CI can access staging Docker'; exit 1
fi
docker info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless'
# Test the live service address; a loopback listener would not prove the staging boundary.
python3 - <<'PY'
import ipaddress
import os
import socket
address = ipaddress.IPv4Address(os.environ['BASKULE_STAGING_ADDRESS'])
if address.is_loopback or address.is_unspecified:
    raise SystemExit('BASKULE_STAGING_ADDRESS must identify the staging interface, not loopback')
port = int(os.environ.get('BASKULE_STAGING_PORT', '47090'))
if not 1 <= port <= 65535:
    raise SystemExit('BASKULE_STAGING_PORT must be between 1 and 65535')
with socket.socket() as connection:
    connection.settimeout(2)
    if connection.connect_ex((str(address), port)) == 0:
        raise SystemExit('CI can reach staging')
print('CI boundary: rootless Docker, no privileged Docker/sudo/checkout or staging access')
PY
