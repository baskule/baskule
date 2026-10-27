# Private-address probes use representative examples, not an operator's network addresses.
# Sourced INSIDE a computer by e2e/v2/infra-smoke.sh (bash). Prints one line per probe.
#   probe_isolation "<name=ip ...>" <computers-net gateway> <stack-net gateway>   -> DENIED|OPEN <target> <detail>
#   probe_internet                                                                -> WORKS|BROKEN <check> <detail>

tcp_open() { timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

probe_one() { # probe_one <label> <host> <port>
  if tcp_open "$2" "$3"; then echo "OPEN $1 $2:$3"
  else
    # Also try HTTP (a proxy could accept TCP and still forward an HTTP request).
    code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$2:$3/" 2>/dev/null)
    if [ -n "$code" ] && [ "$code" != 000 ]; then echo "OPEN $1 $2:$3 http=$code"; else echo "DENIED $1 $2:$3"; fi
  fi
}

probe_isolation() {
  local targets=$1 cgw=$2 ngw=$3 list=() t name ip p
  for t in $targets; do
    name=${t%%=*}; ip=${t#*=}
    case $name in
      celld-*) ports="47091 47092 80" ;; rustfs) ports="47093 80" ;; edge) ports="47090 80" ;;
      computerd) ports="47094 80" ;; openshell) ports="47095 47096 47097 2375 80" ;; *) ports=80 ;;
    esac
    for p in $ports; do list+=("$name|$ip|$p"); done
  done
  list+=(
    "gateway-loopback|127.0.0.1|47095" "volumes-loopback|127.0.0.1|47096" "gateway-health-loopback|127.0.0.1|47097"
    "gateway-localhost|localhost|47095" "gateway-ipv6-loopback|[::1]|47095" "dockerd-tcp|127.0.0.1|2375"
    "compose-dns-computerd|baskule-computerd|47094" "compose-dns-openshell|baskule-openshell|47095"
    "compose-dns-celld|baskule-celld-a|47091" "compose-dns-rustfs|baskule-rustfs|47093"
    "computers-net-gateway|$cgw|80" "computers-net-gateway|$cgw|22" "stack-net-gateway|$ngw|80"
    "host-docker-bridge|172.17.0.1|80" "host-bridge|172.21.0.1|80" "lan-example|192.168.0.2|80" "lan-example-ssh|192.168.0.2|22"
    "lan-router|192.168.1.1|80" "rfc1918-10|10.0.0.1|80" "rfc1918-10|10.0.0.1|443" "rfc1918-172|172.16.0.1|80"
    "rfc1918-192|192.168.0.1|80" "tailnet-example-edge|100.64.0.2|47090" "tailnet-example|100.64.0.2|80"
    "tailnet-example-ssh|100.64.0.2|22" "tailscale-dns|100.100.100.100|80" "cgnat|100.64.0.1|80"
    "metadata|169.254.169.254|80" "metadata-dns|metadata.google.internal|80" "host-docker-internal|host.docker.internal|80"
    "host-openshell-internal|host.openshell.internal|47095" "this-host-zero|0.0.0.0|80"
    "rebind-lan|192.168.0.2.nip.io|80" "rebind-loopback|127.0.0.1.nip.io|47095" "rebind-tailnet-example|100.64.0.2.sslip.io|47090"
    "rebind-tailnet-example-80|100.64.0.2.sslip.io|80" "rebind-10|10.0.0.1.nip.io|80" "rebind-metadata|169.254.169.254.nip.io|80"
    "rebind-localtest|localtest.me|80" "ipv6-ula|[fd00::1]|80" "ipv4-mapped-lan|[::ffff:192.168.0.2]|80"
  )
  local i=0 out
  out=$(mktemp -d)
  for t in "${list[@]}"; do
    IFS='|' read -r name ip p <<<"$t"
    probe_one "$name" "$ip" "$p" > "$out/$i" &
    i=$((i + 1))
    (( i % 12 == 0 )) && wait
  done
  wait
  cat "$out"/* ; rm -rf "$out"
  # Unix sockets: no Docker socket inside the computer.
  for s in /var/run/docker.sock /run/docker.sock; do
    if [ -S "$s" ]; then echo "OPEN docker-socket $s"; else echo "DENIED docker-socket $s"; fi
  done
}

w() { # w <name> <command...>
  local name=$1; shift
  local t0=$SECONDS out
  if out=$("$@" 2>&1); then echo "WORKS $name ($((SECONDS - t0)) s)"; else echo "BROKEN $name: $(echo "$out" | tail -2 | tr '\n' ' ' | cut -c1-200)"; fi
}

probe_internet() {
  local tmp; tmp=$(mktemp -d)
  w https-example.com bash -c 'test "$(curl -s -m 20 -o /dev/null -w %{http_code} https://example.com/)" = 200'
  w https-wikipedia bash -c 'test "$(curl -s -m 20 -o /dev/null -w %{http_code} https://www.wikipedia.org/)" = 200'
  w http-port-80 bash -c 'curl -s -m 20 -o /dev/null -w %{http_code} http://example.com/ | grep -q "^[23]"'
  w https-ip-literal-9.9.9.9 bash -c 'curl -s -m 20 -o /dev/null -w %{http_code} https://9.9.9.9/ | grep -qv "^000$"'
  w ssh-github.com-22 bash -c 'timeout 15 bash -c "exec 3<>/dev/tcp/github.com/22; head -c 7 <&3" | grep -q SSH'
  w pip-install bash -c "python3 -m venv $tmp/venv && $tmp/venv/bin/pip install -q --disable-pip-version-check requests==2.32.3 && $tmp/venv/bin/python -c 'import requests; assert requests.get(\"https://pypi.org/simple/\", timeout=20).ok'"
  w npm-install bash -c "mkdir -p $tmp/npm && cd $tmp/npm && npm init -y >/dev/null && npm install --no-audit --no-fund -s is-number@7 && node -e 'require(\"is-number\")'"
  w git-clone bash -c "git clone -q --depth 1 https://github.com/octocat/Hello-World.git $tmp/git && test -f $tmp/git/README"
  w chromium-page-load bash -c "timeout 90 chromium-baskule --headless --user-data-dir=$tmp/chrome --dump-dom https://example.com/ 2>/dev/null | grep -q 'Example Domain'"
  rm -rf "$tmp"
}
