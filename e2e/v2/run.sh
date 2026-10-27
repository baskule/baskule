#!/usr/bin/env bash
# Baskule 0.2 browser end-to-end suite against the REAL stack (deploy/v2 on :47090), signed in, system Chrome.
#
#   e2e/v2/run.sh                        acceptance: phase 1 `main` (parallel), then phase 2 `lifecycle` (@slow, serial)
#   e2e/v2/run.sh --grep @chat           one area (both phases; a phase with no match is skipped)
#   e2e/v2/run.sh tests/05-*.ts          files, --grep, ... go to `playwright test`
#   E2E_SLOW=0 e2e/v2/run.sh             skip the lifecycle phase (idle/restart/failover/same-chat restart)
#   e2e/v2/run.sh --project perf         one project only (perf = @perf measurements, never in acceptance)
#   E2E_REAL=1 e2e/v2/run.sh             also the real-model subset (mistral-large-4, metered, logged in the ledger)
#
# What it does:
#   1. takes the stack lock (deploy/v2/.stack-lock; waits STACK_LOCK_WAIT seconds, default 600, for another owner);
#   2. BUILD=1: deploy/v2/build.sh first (T3_APP_DIR selects the fork checkout); otherwise starts the stack if down;
#   3. points the cells at the e2e LLM router (e2e/v2/llm: fake by default, real for "[[real]]" messages, budget
#      E2E_REAL_BUDGET, default $0.25 per router lifetime; no redeploy when already pointed at it) and sets computerd's
#      idle stop to E2E_IDLE_MINUTES (1.5);
#   4. runs Playwright (e2e/v2/playwright.config.ts) in two phases; artifacts in e2e/v2/artifacts/
#      (results-main.json, results-lifecycle.json);
#   5. appends the metered real-model spend to .run/llm-spend.md (if any);
#   6. restores: the saved organization settings ( KEEP_ROUTER=1 keeps the router for
#      the next run of an iteration session — restore before you finish), releases the lock.
# Env: E2E_RUN (fixture id; default a timestamp), E2E_WORKERS (main phase, default 2), E2E_CHROME, KEEP_ROUTER=1,
#      RESTORE=0, BUILD=1, T3_APP_DIR. Which selection to run for a change: docs/development-workflow.md.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
. "$ROOT/deploy/v2/lib.sh"
export STACK_LOCK_OWNER=${STACK_LOCK_OWNER:-wp-h-e2e}
export STACK_LOCK_WAIT=${STACK_LOCK_WAIT:-600}
export PATH="$ROOT/.tools/bin:$ROOT/.tools/node-v24.22.1-linux-x64/bin:$PATH"
say() { printf '\033[1m[e2e/v2 %s]\033[0m %s\n' "$(date +%T)" "$*"; }

stack_lock_acquire $$ "e2e/v2/run.sh $*" || exit 1
RC=0
cleanup() {
  local rc=$?; [ $RC -ne 0 ] && rc=$RC
  if docker container inspect baskule02-e2e-llm >/dev/null 2>&1; then
    after=$("$HERE/llm/llm.sh" usage 2>/dev/null || echo '{}')
    node -e '
      const [b, a, ledger, run] = process.argv.slice(1);
      const B = JSON.parse(b || "{}"), A = JSON.parse(a || "{}");
      const d = (k) => (A[k] ?? 0) - (B[k] ?? 0);
      if (d("requests") <= 0) process.exit(0);
      const line = `| ${new Date().toISOString().slice(0, 10)} | WP-H e2e/v2/run.sh (run ${run}): real-model subset through the e2e LLM router, ${d("requests")} chat completions, mistral-large-4 metered by the router | ${d("input")} in (${d("cached")} cached) / ${d("output")} out | ~$${d("upperBoundUsd").toFixed(4)} (upper bound, all input at $1.36/M) |\n`;
      require("fs").mkdirSync(require("path").dirname(ledger), { recursive: true });
      require("fs").appendFileSync(ledger, line);
      console.log("real-model spend logged: " + line.trim());' "${before:-{\}}" "$after" "$ROOT/.run/llm-spend.md" "$E2E_RUN" || true
  fi
  if [ "${RESTORE:-1}" = 1 ]; then
    if [ "${KEEP_ROUTER:-0}" != 1 ]; then say "restore organization settings"; "$HERE/llm/llm.sh" restore >/dev/null 2>&1 || true; fi
  fi
  stack_lock_release
  say "exit $rc"
  exit $rc
}
trap cleanup EXIT

if [ "${BUILD:-0}" = 1 ]; then
  say "build + deploy (deploy/v2/build.sh)"
  "$V2/build.sh" || exit 1
  # Nodes adopt a new deployment by moving resident cells (forced after 60 s); a turn started in that window can be
  # lost. Let the deployment settle before starting a turn.
  say "waiting 75 s for the cells to move to the new deployment"; sleep 75
elif [ "$(docker inspect -f '{{.State.Running}}' baskule02-celld-a 2>/dev/null)" != true ]; then
  say "stack is down: deploy/v2/up.sh"
  "$V2/up.sh" || exit 1
fi
export E2E_IDLE_MINUTES=${E2E_IDLE_MINUTES:-1.5}
say "LLM router"
"$HERE/llm/llm.sh" router "${E2E_REAL_BUDGET:-0.25}" || exit 1
before=$("$HERE/llm/llm.sh" usage)

[ -d "$ROOT/e2e/node_modules/@playwright/test" ] || (cd "$ROOT/e2e" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile --prefer-offline)
mkdir -p "$HERE/artifacts"
rm -rf "$HERE/artifacts/test-results"
b=$(env_get BASKULE02_BIND); p=$(env_get BASKULE02_PORT)
export E2E_BASE_URL=${E2E_BASE_URL:-http://${b:-127.0.0.1}:${p:-47090}}
export E2E_RUN=${E2E_RUN:-$(date -u +%m%d%H%M)}
say "playwright (run $E2E_RUN, $E2E_BASE_URL, version $(curl -s "$E2E_BASE_URL/version.json" | jq -c '{umbrella, fork}'))"
curl -s "$E2E_BASE_URL/version.json" >"$HERE/artifacts/version.json" || true
PW="$ROOT/e2e/node_modules/.bin/playwright"
phase() { # phase <project> [playwright args]: one Playwright invocation, timed
  local project=$1 t0 rc=0; shift
  t0=$(date +%s)
  say "phase $project"
  (cd "$HERE" && E2E_RESULTS_FILE="artifacts/results-$project.json" "$PW" test --project "$project" --pass-with-no-tests "$@") || rc=$?
  say "phase $project: exit $rc in $(( $(date +%s) - t0 )) s"
  [ $rc -ne 0 ] && RC=$rc
  return 0
}
if printf '%s\n' "$@" | grep -q -- '^--project'; then
  (cd "$HERE" && "$PW" test --pass-with-no-tests "$@") || RC=$?
else
  phase main "$@"
  if [ "${E2E_SLOW:-1}" = 1 ]; then phase lifecycle "$@"; else say "lifecycle phase skipped (E2E_SLOW=0)"; fi
fi
say "playwright exit $RC"
exit $RC
