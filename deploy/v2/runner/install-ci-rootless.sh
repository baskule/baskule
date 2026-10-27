#!/usr/bin/env bash
# Root-owned host setup. Prepare is safe with active jobs; activate requires all CI workers to be stopped.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'run as root' >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
uid=$(id -u ghrunner)
runtime=/run/user/$uid
mode=${1:-prepare}
as_ci() { runuser -u ghrunner -- env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" "$@"; }

case "$mode" in
prepare)
  : "${BASKULE_STAGING_PUBLIC_IP:?set the staging host public IPv4 address before installing its policy}"
  staging_public_ip=$(python3 -c 'import ipaddress, os; print(ipaddress.IPv4Address(os.environ["BASKULE_STAGING_PUBLIC_IP"]))')
  apt-get update -qq
  apt-get install -y --no-install-recommends uidmap dbus-user-session slirp4netns
  # These accounts must not create new PAM/cron sessions outside their protected cgroups.
  printf 'DenyUsers ghrunner baskule-deploy\n' >/etc/ssh/sshd_config.d/60-baskule-runners.conf
  /usr/sbin/sshd -t
  systemctl reload ssh
  # Dedicated, non-overlapping IDs. Refuse to steal any existing allocation.
  python3 - <<'PY'
from pathlib import Path
for filename in ('/etc/subuid', '/etc/subgid'):
    path = Path(filename)
    entries = [line.split(':') for line in path.read_text().splitlines() if line]
    if any(name == 'ghrunner' and int(count) >= 65536 for name, start, count in entries):
        continue
    start = max([200000] + [int(start) + int(count) for name, start, count in entries])
    with path.open('a') as output:
        output.write(f'ghrunner:{start}:65536\n')
for service in ('cron', 'at'):
    allow = Path(f'/etc/{service}.allow')
    deny = Path(f'/etc/{service}.deny')
    blocked = {'ghrunner', 'baskule-deploy'}
    if allow.exists():
        allow.write_text(''.join(line for line in allow.read_text().splitlines(keepends=True)
                                if line.split('#', 1)[0].strip() not in blocked))
    elif deny.exists():
        existing = deny.read_text()
        names = {line.split('#', 1)[0].strip() for line in existing.splitlines()}
        deny.write_text(existing.rstrip() + '\n' + ''.join(name + '\n' for name in sorted(blocked - names)))
    else:
        # With neither file these tools are root-only; preserve that policy.
        allow.write_text('root\n')
PY
  install -d -m 755 "/etc/systemd/system/user-$uid.slice.d"
  install -m 644 "$HERE/ci-user.slice" "/etc/systemd/system/user-$uid.slice.d/baskule-ci.conf"
  printf 'IPAddressDeny=%s/32\n' "$staging_public_ip" >>"/etc/systemd/system/user-$uid.slice.d/baskule-ci.conf"
  install -d -m 755 "/etc/systemd/system/user@$uid.service.d"
  printf '[Service]\nDelegate=cpu cpuset io memory pids\n' \
    >"/etc/systemd/system/user@$uid.service.d/baskule-ci.conf"
  install -d -o ghrunner -g ghrunner -m 700 /srv/ghrunner/.config/{docker,systemd/user}
  install -o ghrunner -g ghrunner -m 644 "$HERE/ci-daemon.json" /srv/ghrunner/.config/docker/daemon.json
  install -o ghrunner -g ghrunner -m 644 "$HERE/ci-docker.service" /srv/ghrunner/.config/systemd/user/docker.service
  systemctl daemon-reload
  loginctl enable-linger ghrunner
  systemctl start "user@$uid.service"
  as_ci systemctl --user daemon-reload
  as_ci systemctl --user enable --now docker.service
  as_ci docker --host="unix://$runtime/docker.sock" info --format '{{json .SecurityOptions}} {{.CgroupDriver}}'
  ;;
activate)
  units=(actions.runner.baskule-baskule.baskule-contabo-ci{,-2,-3}.service)
  for unit in "${units[@]}"; do
    if systemctl is-active --quiet "$unit"; then
      echo "Stop idle workers first; $unit is still active" >&2; exit 1
    fi
  done
  if id -nG ghrunner | tr ' ' '\n' | grep -qx docker; then gpasswd -d ghrunner docker; fi
  # Supplementary groups are cached by the user manager and its children too.
  systemctl restart "user@$uid.service"
  as_ci systemctl --user start docker.service
  for unit in "${units[@]}"; do
    install -d -m 755 "/etc/systemd/system/$unit.d"
    printf '[Service]\nSlice=user-%s.slice\nEnvironment=DOCKER_HOST=unix://%s/docker.sock\n' "$uid" "$runtime" \
      >"/etc/systemd/system/$unit.d/rootless.conf"
  done
  as_ci docker context inspect baskule-ci >/dev/null 2>&1 || \
    as_ci docker context create baskule-ci --docker "host=unix://$runtime/docker.sock" >/dev/null
  as_ci docker context use baskule-ci
  systemctl daemon-reload
  systemctl start "${units[@]}"
  ;;
*) echo 'usage: install-ci-rootless.sh prepare|activate' >&2; exit 2 ;;
esac
