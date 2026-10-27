#!/usr/bin/env bash
# Baskule 0.2 infrastructure smoke test (WP-A). No LLM spend.
#   1. stack up (deploy/v2/up.sh), both celld nodes healthy, the edge serves the Worker on the Tailscale port;
#   2. computerd: the full computerd/v2 integration suite run INSIDE the stack network (ensure, exec uname/python/
#      node, stdin, kill, files, stdio, Playwright MCP, CDP, persistence across stop/start, idle stop with a short
#      organization idle policy), plus the authenticated runtime-policy endpoint;
#   3. isolation probes FROM INSIDE a computer (all must fail) and public internet (all must work);
#   4. failover drill: kill celld-a, the Worker is still served through the edge, then restart it.
# Usage: e2e/v2/infra-smoke.sh [--no-up] [--down]   (--down: stop the stack at the end; data kept)
# Output: one line per check (PASS/FAIL), summary at the end; exit 1 if any FAIL.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
V2=$ROOT/deploy/v2
. "$V2/lib.sh"
UP=1; DOWN=0
for a in "$@"; do case $a in --no-up) UP=0 ;; --down) DOWN=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done
# It kills a celld node and may start the stack: hold the shared stack lock like every live loop.
export STACK_LOCK_OWNER=${STACK_LOCK_OWNER:-infra-smoke} STACK_LOCK_WAIT=${STACK_LOCK_WAIT:-600}
stack_lock_acquire $$ "e2e/v2/infra-smoke.sh $*" || exit 1
for k in BASKULE02_BIND BASKULE02_PORT ADMIN_EMAIL ADMIN_PASSWORD COMPUTERD_TOKEN; do export "$k=$(env_get $k)"; done
EDGE="http://${BASKULE02_BIND:-127.0.0.1}:${BASKULE02_PORT:-47090}"
PASS=0; FAIL=0; FAILED=()
ok() { PASS=$((PASS + 1)); echo "PASS  $*"; }
ko() { FAIL=$((FAIL + 1)); FAILED+=("$*"); echo "FAIL  $*"; }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else ko "$name"; fi; }
SPACE=smoke$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')
HELPER=baskule02-smoke

cleanup() {
  docker rm -f "$HELPER" >/dev/null 2>&1
  # Remove the smoke computer and its volume.
  docker exec baskule02-openshell openshell --gateway-endpoint http://127.0.0.1:47095 sandbox delete "os-$SPACE" >/dev/null 2>&1
  for _ in $(seq 30); do docker exec baskule02-openshell docker volume rm "baskule-space-$SPACE" >/dev/null 2>&1 && break; sleep 1; done
  # Restore computerd's configured idle timeout.
  node "$HERE/llm/settings.mjs" restore >/dev/null 2>&1 || true
  [ "$DOWN" = 1 ] && "$V2/down.sh" >/dev/null 2>&1
  stack_lock_release
}
trap cleanup EXIT

# ------------------------------------------------------------------------------------------- 1. stack
if [ "$UP" = 1 ]; then "$V2/up.sh" >/dev/null 2>&1 || { echo "deploy/v2/up.sh failed"; exit 1; }; fi
# An external bucket (S3_ENDPOINT, contabo.md) replaces RustFS.
S3=$(env_get S3_ENDPOINT)
for c in $([ -z "$S3" ] && echo baskule02-rustfs) baskule02-celld-a baskule02-celld-b baskule02-computerd baskule02-openshell; do
  check "container $c healthy" wait_healthy "$c" 120
done
check "edge running" test "$(docker inspect -f '{{.State.Running}}' baskule02-edge)" = true
for n in a b; do
  check "celld-$n health route" docker exec "baskule02-celld-$n" curl -sf -m 5 -o /dev/null http://127.0.0.1:47091/.well-known/celld/health
done
s3_region=$(env_get S3_REGION)
if [ -n "$S3" ]; then s3_id=$(env_get S3_ACCESS_KEY) s3_secret=$(env_get S3_SECRET_KEY) s3_url=$S3
else s3_id=$(env_get RUSTFS_ACCESS_KEY) s3_secret=$(env_get RUSTFS_SECRET_KEY) s3_url=http://baskule-rustfs:47093; fi
fleet=$(docker run --rm --network baskule02-net -e AWS_ACCESS_KEY_ID="$s3_id" -e AWS_SECRET_ACCESS_KEY="$s3_secret" \
  -e AWS_REGION="${s3_region:-us-east-1}" "baskule-celld:$TAG" diagnose --read-only --json \
  --bucket "s3://$(env_get CELLD_BUCKET_NAME)" --endpoint "$s3_url" 2>/dev/null)
check "fleet: two node leases on the one bucket" bash -c "echo '$fleet' | grep -q '\"detail\":\"2 node lease'"
check "fleet: both peers answer a signed probe" bash -c "test \$(echo '$fleet' | grep -c '\"check\":\"peer baskule02-[ab].*\"verdict\":\"ok\"') = 2"
check "edge: GET / -> 200" bash -c "curl -sf -m 10 -o /dev/null $EDGE/"
app=$(curl -s -m 10 "$EDGE/" | head -c 200)
if echo "$app" | grep -q "hello from baskule02"; then
  check "edge: hello Worker DO counter (cell + bucket)" bash -c "curl -sf -m 20 $EDGE/count/smoke | grep -q '\"n\"'"
else
  # Anonymous installations (auth.json) answer every request as the shared identity.
  if curl -s -m 10 "$EDGE/.well-known/baskule" | grep -q '"mode":"anonymous"'; then me=200; else me=401; fi
  check "edge: platform Worker answers /api/baskule/me with $me" bash -c "test \$(curl -s -m 10 -o /dev/null -w '%{http_code}' $EDGE/api/baskule/me) = $me"
  if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
    check "edge: admin sign-in through ControlCell (cell + bucket)" bash -c \
      "curl -sf -m 30 -o /dev/null -H 'content-type: application/json' -H 'origin: $EDGE' -d \"\$(jq -n --arg e \"\$ADMIN_EMAIL\" --arg p \"\$ADMIN_PASSWORD\" '{email:\$e,password:\$p}')\" $EDGE/auth/sign-in/email"
  fi
fi
[ "${BASKULE02_BIND:-127.0.0.1}" = 127.0.0.1 ] ||
  check "edge is not published on other addresses" bash -c "! curl -s -m 3 -o /dev/null http://127.0.0.1:${BASKULE02_PORT:-47090}/"

# ------------------------------------------------------------------------- 2. computerd (inside the stack network)
docker rm -f "$HELPER" >/dev/null 2>&1
docker run -d --name "$HELPER" --network baskule02-net -e COMPUTERD_TOKEN="$COMPUTERD_TOKEN" \
  -v "$HERE/infra:/infra:ro" --entrypoint sleep "baskule-celld:$TAG" infinity >/dev/null
cx() { docker exec -i "$HELPER" /infra/cx.sh "$SPACE" "$1"; } # run a bash script in the smoke computer

# Short idle timeout for the idle-stop check (restored in cleanup).
node "$HERE/llm/settings.mjs" idle 1
echo "----- computerd integration suite (space $SPACE) -----"
if docker run --rm --network baskule02-net -v "$ROOT/computerd/v2/test:/app/test:ro" \
     -e COMPUTERD_URL=http://baskule-computerd:47094 -e COMPUTERD_TOKEN="$COMPUTERD_TOKEN" -e SPACE="$SPACE" \
     -e IDLE_EXPECT_S=120 "baskule-computerd:$TAG" node --disable-warning=ExperimentalWarning --test \
     --test-reporter=spec /app/test/integration.ts 2>&1 | sed 's/^/      /' | tee /tmp/baskule02-smoke-it.log | grep -E '✔|✖|﹣|^      #'; \
   grep -q '✖' /tmp/baskule02-smoke-it.log; then
  ko "computerd integration suite (see /tmp/baskule02-smoke-it.log)"
else
  ok "computerd integration suite: ensure, exec, stdin, kill, files, stdio, Playwright MCP, CDP, persistence, idle stop, delete"
fi

check "runtime policy: token grants idle settings only" docker exec "$HELPER" bash -c \
  'curl -sf -H "Authorization: Bearer $COMPUTERD_TOKEN" http://baskule-edge:47090/api/baskule/runtime-settings | jq -e "keys == [\"idleMinutes\"]" '
check "runtime policy: refused without the token" docker exec "$HELPER" bash -c \
  'test "$(curl -s -o /dev/null -w %{http_code} http://baskule-edge:47090/api/baskule/runtime-settings)" = 401'

# ------------------------------------------------------------------------------ 3. isolation + internet
ip_of() { docker inspect -f "{{range \$k, \$v := .NetworkSettings.Networks}}{{\$v.IPAddress}} {{end}}" "$1" | awk '{print $1}'; }
TARGETS=""
for c in celld-a celld-b rustfs edge computerd openshell; do TARGETS="$TARGETS $c=$(ip_of baskule02-$c)"; done
COMPUTERS_GW=$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' baskule02-computers)
NET_GW=$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' baskule02-net)
echo "----- isolation probes from inside the computer (each must FAIL to connect) -----"
probe_out=$(cx "$(cat "$HERE/infra/probe.sh")
probe_isolation '$TARGETS' '$COMPUTERS_GW' '$NET_GW'" 2>&1)
echo "$probe_out" | grep -E '^(DENIED|OPEN) ' | sed 's/^/      /'
n_open=$(echo "$probe_out" | grep -c '^OPEN ')
n_denied=$(echo "$probe_out" | grep -c '^DENIED ')
if [ "$n_open" = 0 ] && [ "$n_denied" -ge 30 ]; then ok "isolation: $n_denied/$n_denied private destinations unreachable from the computer"
else ko "isolation: $n_open reachable destination(s) (of $((n_open + n_denied)))"; fi

echo "----- public internet from inside the computer (each must work) -----"
net_out=$(cx "$(cat "$HERE/infra/probe.sh")
probe_internet" 2>&1)
echo "$net_out" | grep -E '^(WORKS|BROKEN) ' | sed 's/^/      /'
n_broken=$(echo "$net_out" | grep -c '^BROKEN ')
n_works=$(echo "$net_out" | grep -c '^WORKS ')
if [ "$n_broken" = 0 ] && [ "$n_works" -ge 6 ]; then ok "internet: $n_works/$n_works public checks work (https, IP literal, pip, npm, git clone, Chromium)"
else ko "internet: $n_broken broken (of $((n_works + n_broken)))"; fi

# ------------------------------------------------------------------------------------- 4. failover drill
# Kill the node that owns the most cells (e.g. ControlCell), so the drill also exercises cell takeover.
owned() { docker exec "baskule02-celld-$1" curl -sf -m 5 http://127.0.0.1:47092/state | jq '.owned_cells // 0' 2>/dev/null || echo 0; }
VICTIM=a; [ "$(owned b)" -gt "$(owned a)" ] && VICTIM=b
echo "----- failover drill: kill -9 celld-$VICTIM (owned cells: a=$(owned a) b=$(owned b)) -----"
docker kill "baskule02-celld-$VICTIM" >/dev/null
t0=$(date +%s.%N); fails=0
for i in $(seq 20); do
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$EDGE/")
  [ "$code" = 200 ] || fails=$((fails + 1))
  sleep 0.25
done
if [ "$fails" = 0 ]; then ok "failover: 20/20 Worker requests served through the edge with celld-$VICTIM dead"
else ko "failover: $fails/20 Worker requests failed with celld-$VICTIM dead"; fi
if ! echo "$app" | grep -q "hello from baskule02" && [ -n "${ADMIN_PASSWORD:-}" ]; then
  # A cell owned by the dead node moves after its lease expires.
  t1=$(date +%s)
  for _ in $(seq 90); do
    curl -sf -m 10 -o /dev/null -H 'content-type: application/json' -H "origin: $EDGE" \
      -d "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')" "$EDGE/auth/sign-in/email" && break
    sleep 1
  done
  if [ $(( $(date +%s) - t1 )) -lt 90 ]; then ok "failover: ControlCell serves sign-in again after $(( $(date +%s) - t1 )) s"
  else ko "failover: ControlCell not back after 90 s"; fi
fi
docker start "baskule02-celld-$VICTIM" >/dev/null
check "failover: celld-$VICTIM back and healthy" wait_healthy "baskule02-celld-$VICTIM" 120

echo "----- summary: $PASS passed, $FAIL failed -----"
for f in "${FAILED[@]}"; do echo "  failed: $f"; done
[ "$FAIL" = 0 ]
