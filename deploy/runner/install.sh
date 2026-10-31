#!/usr/bin/env bash
# Run as root from a reviewed checkout. Read a short-lived GitHub runner registration token on stdin.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'run as root' >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
: "${BASKULE_STAGING_PUBLIC_IP:?set the staging host public IPv4 address before installing its policy}"
staging_public_ip=$(python3 -c 'import ipaddress, os; print(ipaddress.IPv4Address(os.environ["BASKULE_STAGING_PUBLIC_IP"]))')
account=baskule-deploy
directory=/srv/baskule-deploy
read -r registration_token
[ -n "$registration_token" ] || exit 1
id "$account" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$directory" --shell /usr/sbin/nologin "$account"
install -d -o "$account" -g "$account" -m 700 "$directory/runner" "$directory/work"
install -o root -g root -m 755 "$HERE/deploy.py" /usr/local/sbin/baskule-deploy.new
mv /usr/local/sbin/baskule-deploy.new /usr/local/sbin/baskule-deploy
printf '%s\n' 'baskule-deploy ALL=(root) NOPASSWD: /usr/local/sbin/baskule-deploy' >/etc/sudoers.d/baskule-deploy
chmod 440 /etc/sudoers.d/baskule-deploy
visudo -cf /etc/sudoers.d/baskule-deploy
cd "$directory/runner"
if [ ! -f .runner ]; then
  archive=$(mktemp)
  trap 'rm -f "$archive"' EXIT
  curl -fsSL https://github.com/actions/runner/releases/download/v2.338.1/actions-runner-linux-x64-2.338.1.tar.gz -o "$archive"
  echo "08e9ccb3604d2462c24b5e33604dc30810296ca15cc65f23cffd4317eb144c37  $archive" | sha256sum -c --quiet
  tar xzf "$archive"
  ./bin/installdependencies.sh
  chown -R "$account:$account" .
  sudo -u "$account" ./config.sh --unattended --url https://github.com/baskule/baskule \
    --token "$registration_token" --name baskule-dedicated-deploy --labels baskule-deploy \
    --work "$directory/work"
  # Keep runner auto-updates enabled; GitHub stops assigning jobs to stale runners.
  ./svc.sh install "$account"
fi
unit=actions.runner.baskule-baskule.baskule-dedicated-deploy.service
install -d -m 755 "/etc/systemd/system/$unit.d"
install -o root -g root -m 644 "$HERE/network.conf" "/etc/systemd/system/$unit.d/network.conf"
printf 'IPAddressDeny=%s/32\n' "$staging_public_ip" >>"/etc/systemd/system/$unit.d/network.conf"
systemctl daemon-reload
systemctl restart "$unit"
