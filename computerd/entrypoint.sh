#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi
if [ -S /var/run/docker.sock ]; then
  exec setpriv --reuid=node --regid=node --groups="$(stat -c %g /var/run/docker.sock)" --inh-caps=-all "$@"
fi
exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all "$@"
