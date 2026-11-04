#!/usr/bin/env bash
# Docker computer isolation against this worktree's full, fake-LLM development stack: private destinations denied,
# public internet works, guard rules survive a computerd restart without duplicates, a deleted rule is restored by
# reconciliation, and computerd refuses to create computers when the guard cannot be verified (HTTP 503).
# Usage: e2e/computer-isolation.sh [--no-up] [--down]. The deployed-stack equivalent is e2e/infra-smoke.sh.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
source scripts/env.sh
export BASKULE_STACK_PROXY=0
EVIDENCE="$ROOT/.run/evidence/isolation"
mkdir -p "$EVIDENCE"
UP=1; DOWN=0
for arg; do case $arg in --no-up) UP=0;; --down) DOWN=1;; *) exit 2;; esac; done
if (( UP )); then scripts/stack up --profile full; DOWN=1; fi
state="$ROOT/.run/stack/stack.json"
export COMPUTERD_URL="http://127.0.0.1:$(jq -r '.ports.computerd' "$state")"
export COMPUTERD_TOKEN=$(jq -r '.computerdToken' "$state")
instance=$(jq -r '.id' "$state")
network="baskule-computers-$instance"
space="isolation-$(date +%s)-$$"
request() { curl --fail-with-body -sS -H "Authorization: Bearer $COMPUTERD_TOKEN" -H 'Content-Type: application/json' -X POST "$COMPUTERD_URL/v1/spaces/$1/computer/$2" -d "$(jq -nc --arg s "$1" '{confirm:$s}')"; }
cleanup() {
  if [[ -n ${dummy:-} ]]; then iptables -w -D FORWARD -s "$subnet" -m comment --comment "$dummy" -j ACCEPT || true; fi
  request "$space" delete >/dev/null || true
  request "$space-peer" delete >/dev/null || true
  if (( DOWN )); then scripts/stack down; fi
}
trap cleanup EXIT
scripts/stack doctor
request "$space" ensure > "$EVIDENCE/ensure.json"
request "$space-peer" ensure > "$EVIDENCE/peer.json"
peer=$(docker ps -q --filter "label=baskule.instance=$instance" --filter "label=baskule.space=$space-peer")
test -n "$peer"
ip_of() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$1"; }
docker exec -d "$peer" python3 -m http.server 8080
targets="computer=$(ip_of "$peer")"
# Inspect other services read-only; never restart or remove their resources.
while read -r id name; do
  case "$name" in *celld*|*rustfs*|*computerd*|*edge*|*web*)
    for ip in $(ip_of "$id"); do targets+=" ${name}=$ip"; done;;
  esac
done < <(docker ps --format '{{.ID}} {{.Names}}')
for ip in $(ip -j -4 addr show | jq -r '.[].addr_info[].local'); do targets+=" host=$ip"; done
for net in $(docker network ls -q --filter driver=bridge); do
  for ip in $(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' "$net"); do targets+=" bridge=$ip"; done
done
gateway=$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$network")
# Host loopback is the computer's own loopback, not a route to the host.
targets=$(printf '%s' "$targets" | sed 's/ host=127\.[0-9.]*/ /g')
"$ROOT/e2e/infra/cx.sh" "$space" "HOST_SERVICE_PORTS='$(jq -r '.ports | values | join(" ")' "$state")'
$(cat e2e/infra/probe.sh)
probe_isolation '$targets' '$gateway' '$gateway'
probe_internet" | tee "$EVIDENCE/probes.log"
if grep -E '^(OPEN|BROKEN) ' "$EVIDENCE/probes.log"; then exit 1; fi
test "$(grep -c '^DENIED ' "$EVIDENCE/probes.log")" -ge 30
test "$(grep -c '^WORKS ' "$EVIDENCE/probes.log")" -ge 11
subnet=$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$network")
chain=$(node --input-type=module -e 'import {guardChain} from "./computerd/src/guard.ts"; console.log(guardChain([process.argv[1]]))' "$subnet")
rules() {
  iptables -w -S "$chain"
  for parent in DOCKER-USER INPUT FORWARD; do
    first=$(iptables -w -S "$parent" | grep '^-A ' | head -n 1)
    test "$first" = "-A $parent -s $subnet -j $chain" || return 1
    echo "$first"
  done
}
rules > "$EVIDENCE/rules-before.txt"
scripts/stack restart computerd
request "$space" ensure >/dev/null
rules > "$EVIDENCE/rules-after.txt"
cmp "$EVIDENCE/rules-before.txt" "$EVIDENCE/rules-after.txt"
dummy="baskule-isolation-order-$space"
iptables -w -I FORWARD 1 -s "$subnet" -m comment --comment "$dummy" -j ACCEPT
start=$SECONDS
until rules > "$EVIDENCE/reconciled.txt"; do
  if (( SECONDS - start >= 70 )); then echo 'FAIL guard restoration'; exit 1; fi
  python3 -c 'import threading; threading.Event().wait(1)'
done
iptables -w -D FORWARD -s "$subnet" -m comment --comment "$dummy" -j ACCEPT
dummy=""
printf 'PASS ordering restored in %s seconds\n' "$((SECONDS-start))" | tee "$EVIDENCE/reconciliation.txt"
export ISOLATION_NETWORK="$network" ISOLATION_INSTANCE="$instance-fail" ISOLATION_EVIDENCE="$EVIDENCE"
python3 - <<'PYFAIL'
import json, os, socket, subprocess, time, urllib.request, urllib.error
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
env = dict(os.environ, COMPUTERD_PORT=str(port), COMPUTERD_HOST='127.0.0.1',
           COMPUTER_BACKEND='docker', COMPUTER_NETWORK=os.environ['ISOLATION_NETWORK'],
           COMPUTERD_INSTANCE=os.environ['ISOLATION_INSTANCE'],
           COMPUTER_GUARD_IMAGE='baskule-isolation-missing:never')
with open(os.environ['ISOLATION_EVIDENCE']+'/fail-closed.log', 'w') as log:
    process = subprocess.Popen(['node', 'computerd/src/main.ts'], env=env, stdout=log, stderr=log)
    try:
        deadline = time.monotonic()+30
        while True:
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=1); break
            except OSError:
                assert time.monotonic()<deadline and process.poll() is None
                time.sleep(.1)
        req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/spaces/fail-closed/computer/ensure',
            data=b'{}', headers={'Authorization':'Bearer '+env['COMPUTERD_TOKEN'], 'Content-Type':'application/json'})
        try:
            urllib.request.urlopen(req); raise AssertionError('start unexpectedly succeeded')
        except urllib.error.HTTPError as error:
            body=error.read().decode(); assert error.code==503 and 'No such image' in body, body
            log.write(f'HTTP {error.code} {body}\n')
        ids=subprocess.check_output(['docker','ps','-aq','--filter','label=baskule.instance='+env['COMPUTERD_INSTANCE']]).strip()
        assert not ids, ids
        log.write('PASS no computer created\n')
    finally:
        process.terminate(); process.wait(timeout=15)
PYFAIL
printf 'PASS isolation and public connectivity\n'
