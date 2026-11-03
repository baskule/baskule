import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
function exercise(mode = "existing") {
  const malformed = mode === "malformed";
  const iam = mode.startsWith("iam");
  const sweeping = mode.startsWith("sweep-");
  mkdirSync(join(root, ".run"), { recursive: true });
  const fixture = mkdtempSync(join(root, ".run/gke-guard-"));
  // Deliberately too long to name a real Google Cloud project.
  const project = `baskule-ephemeral-fixture-not-a-project-${fixture.split("/").at(-1)}`;
  const stateRoot = join(root, ".run/kubernetes-ephemeral");
  mkdirSync(stateRoot, { recursive: true });
  const ownedState = mkdtempSync(join(stateRoot, "gke.fixture-"));
  const email = `bk-fixture@${project}.iam.gserviceaccount.com`;
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const lock = join(common, `baskule-gke-${project}.lock`);
  const prefix = `https://www.googleapis.com/compute/v1/projects/${project}`;
  try {
    const created = new Date(Date.now() - (mode === "sweep-old" ? 121 : 5) * 60_000).toISOString();
    const labels = { "baskule-ephemeral": "true", "baskule-run": "another-run" };
    writeFileSync(join(fixture, "clusters.json"), JSON.stringify(sweeping ? (mode.includes("cluster") ? [{ name: "other-test", location: "europe-west1-b", resourceLabels: labels, createTime: created }] : []) : (malformed || iam) ? [] : [{ name: "other-test", location: "europe-west1-b", resourceLabels: labels }]));
    writeFileSync(join(fixture, "repositories.json"), JSON.stringify(sweeping && !mode.includes("cluster") ? [{ name: "other-repo", labels, createTime: created }] : []));
    writeFileSync(join(fixture, "instances.json"), JSON.stringify([{ name: "unrelated-vm", selfLink: `${prefix}/zones/europe-west1-b/instances/unrelated-vm`, zone: "europe-west1-b" }]));
    writeFileSync(join(fixture, "accounts.json"), JSON.stringify([{ name: `projects/${project}/serviceAccounts/default`, email: `default@${project}.iam.gserviceaccount.com`, displayName: "Compute Engine default service account" }]));
    writeFileSync(join(fixture, "iam.json"), JSON.stringify({ bindings: iam ? [{ role: "roles/container.defaultNodeServiceAccount", members: [`deleted:serviceAccount:${email}?uid=1`, `serviceAccount:other-${email}`] }] : [] }));
    writeFileSync(join(ownedState, "project.private"), project);
    writeFileSync(join(ownedState, "known-accounts.private.json"), JSON.stringify(iam ? [email] : []));
    writeFileSync(join(ownedState, "owned-links.private.json"), "[]");
    // Exported Bash functions take precedence over any installed SDK. Every
    // unexpected command fails; this test never invokes the real cloud client.
    const result = spawnSync("bash", ["-c", `
      gcloud() {
        printf '%s\\n' "$*" >> "$BASKULE_TEST_FIXTURE/calls"
        case "$*" in
          'config get-value project') printf '%s\\n' "$BASKULE_GKE_PROJECT" ;;
          *'projects get-iam-policy'*) cat "$BASKULE_TEST_FIXTURE/iam.json" ;;
          *'projects remove-iam-policy-binding'*)
            if [[ ! -f $BASKULE_TEST_FIXTURE/retried ]]; then touch "$BASKULE_TEST_FIXTURE/retried"; echo 'HTTP 429 quota' >&2; return 1; fi
            for argument in "$@"; do if [[ $argument == --member=* ]]; then member=\${argument#--member=}; fi; done
            jq --arg member "$member" '.bindings |= map(.members |= map(select(. != $member)))' "$BASKULE_TEST_FIXTURE/iam.json" > "$BASKULE_TEST_FIXTURE/iam.next"
            mv "$BASKULE_TEST_FIXTURE/iam.next" "$BASKULE_TEST_FIXTURE/iam.json" ;;
          *'artifacts repositories list'*) cat "$BASKULE_TEST_FIXTURE/repositories.json" ;;
          *'artifacts repositories delete'*) printf '[]\\n' > "$BASKULE_TEST_FIXTURE/repositories.json" ;;
          *'container clusters delete'*) printf '[]\\n' > "$BASKULE_TEST_FIXTURE/clusters.json" ;;
          *'container clusters list'*) cat "$BASKULE_TEST_FIXTURE/clusters.json" ;;
          *'compute disks list'*) if [[ $BASKULE_TEST_MALFORMED == 1 ]]; then printf 'null\\n'; else printf '[]\\n'; fi ;;
          *'compute instances list'*) cat "$BASKULE_TEST_FIXTURE/instances.json" ;;
          *'iam service-accounts list'*) cat "$BASKULE_TEST_FIXTURE/accounts.json" ;;
          *' list '*) printf '[]\\n' ;;
          *) return 99 ;;
        esac
      }
      export -f gcloud
      if [[ "$BASKULE_TEST_MODE" == live ]]; then
        flock "$BASKULE_TEST_LOCK" bash "$BASKULE_TEST_DRIVER" sweep
      else
        if [[ "$BASKULE_TEST_MODE" == sweep-force ]]; then
          bash "$BASKULE_TEST_DRIVER" sweep --force
        else
          bash "$BASKULE_TEST_DRIVER" "$BASKULE_TEST_ACTION"
        fi
      fi
    `], { cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, BASKULE_GKE_PROJECT: project, BASKULE_TEST_LOCK: lock, BASKULE_TEST_MODE: mode, BASKULE_TEST_MALFORMED: malformed ? "1" : "0", BASKULE_TEST_ACTION: mode === "iam" || sweeping ? "sweep" : "run", BASKULE_TEST_FIXTURE: fixture, BASKULE_TEST_DRIVER: join(root, "e2e/kubernetes-ephemeral.sh") } });
    return { result, policy: JSON.parse(readFileSync(join(fixture, "iam.json"), "utf8")), email, calls: readFileSync(join(fixture, "calls"), "utf8") };
  } finally { rmSync(fixture, { recursive: true, force: true }); for (const name of readdirSync(stateRoot).filter(name => name.startsWith("gke."))) {
      const state = join(stateRoot, name);
      if (existsSync(join(state, "project.private")) && readFileSync(join(state, "project.private"), "utf8") === project) rmSync(state, { recursive: true, force: true });
    }
    rmSync(lock, { force: true }); }
}

test("an existing ephemeral installation refuses a run without deleting resources", () => {
  const { result, calls } = exercise();
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(calls, /\b(create|delete|update|add-iam-policy-binding|remove-iam-policy-binding)\b/);
  assert.match(result.stderr, /clusters: 1 owned resources/);
  assert.match(result.stderr, /instances: 0 owned resources/);
  assert.match(calls, /compute instances list --format=json\(name,zone,labels,selfLink\)/);
  assert.match(result.stderr, /accounts: 0 owned resources/);
  assert.doesNotMatch(result.stderr, /jq: (error|parse error)/);
});

test("malformed inventory fails before any resource mutation", () => {
  const { result, calls } = exercise("malformed");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Resource inventory must contain arrays/);
  assert.doesNotMatch(calls, /\b(create|delete|update|add-iam-policy-binding|remove-iam-policy-binding)\b/);
  assert.doesNotMatch(result.stderr, /disks: 0 owned resources/);
});

test("IAM sweep retries quota errors and removes only known deleted principals", () => {
  const { result, calls, policy, email } = exercise("iam");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.split("\n").filter(line => line.includes("remove-iam-policy-binding")).length, 2);
  assert.deepEqual(policy.bindings[0].members, [`serviceAccount:other-${email}`]);
  assert.match(result.stdout, /iam-bindings: 0 owned references/);
  assert.doesNotMatch(calls, /compute instances delete|iam service-accounts delete/);
});

test("an owned IAM tombstone refuses a new run without deleting the old grant", () => {
  const { result, calls, policy } = exercise("iam-refuse");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /iam-bindings: 1 owned references/);
  assert.equal(policy.bindings[0].members.length, 2);
  assert.doesNotMatch(calls, /\b(create|delete|update|add-iam-policy-binding|remove-iam-policy-binding)\b/);
});

test("global sweep refuses while a worker holds the shared Git common-directory lock", () => {
  const { result, calls } = exercise("live");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Live run exists in this repository; refuse global sweep/);
  assert.doesNotMatch(calls, /\b(create|delete|update|remove-iam-policy-binding)\b/);
});

test("Kubernetes cleanup timeout and repeated signals cannot skip cluster deletion", () => {
  const work = mkdtempSync(join(root, ".run/gke-cleanup-"));
  try {
    const driver = readFileSync(join(root, "e2e/kubernetes-ephemeral.sh"), "utf8");
    const cleanup = driver.slice(driver.indexOf("cleanup() {"), driver.indexOf("if ! audit >"));
    writeFileSync(join(work, "kubeconfig"), "fixture");
    writeFileSync(join(work, "forwarding-rules.private.json"), "[]");
    const result = spawnSync("bash", ["-c", `
      set -euo pipefail
      run_id=baskule-ephemeral-1-abcd; project=fixture; region=europe-west1; zone=europe-west1-b
      state=$1; BASKULE_K8S_EVIDENCE=$1; KUBECONFIG=$1/kubeconfig; DOCKER_CONFIG=$1/docker
      started=$(date +%s); nodes_started=0
      inventory() { :; }; owned() { :; }; sweep() { echo zero; }
      gc() { printf '%s\\n' "$*" >> "$state/calls"; }
      python3() { :; }
      timeout() { printf '%s\\n' "$*" >> "$state/timeouts"; kill -s INT $$; kill -s TERM $$; kill -s HUP $$; return 124; }
      ${cleanup}
      cleanup
    `, "bash", work], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /continuing cluster deletion/);
    assert.match(readFileSync(join(work, "calls"), "utf8"), /container clusters delete baskule-ephemeral-1-abcd/);
    assert.match(readFileSync(join(work, "calls"), "utf8"), /compute addresses delete baskule-ephemeral-1-abcd --global/);
    assert.match(readFileSync(join(work, "timeouts"), "utf8"), /--kill-after=30s 8m/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("ownership uses labels with forwarding-rule recovery and run IDs for unlabelled LBs", () => {
  const work = mkdtempSync(join(root, ".run/gke-ownership-"));
  try {
    const driver = readFileSync(join(root, "e2e/kubernetes-ephemeral.sh"), "utf8");
    const filter = driver.split("owned_filter='")[1].split(/'\n\n?kinds=/)[0].trim();
    const run = "baskule-ephemeral-1234-abcd";
    const resources = [
      { name: "actual", labels: { "baskule-ephemeral": "true", "baskule-run": run }, selfLink: "actual" },
      { name: `unrelated-${run}`, labels: { owner: "someone-else" }, selfLink: "unrelated" },
      { name: "lb", description: `namespace: ${run}`, selfLink: "lb" },
      { name: "baskule-ephemeral-unrelated", selfLink: "other" },
    ];
    for (const [file, value] of Object.entries({ resources, runs: [run], links: ["unrelated"], accounts: [], addresses: [] })) writeFileSync(join(work, `${file}.json`), JSON.stringify(value));
    for (const [kind, expected] of [["instances", ["actual"]], ["disks", ["actual"]], ["forwarding-rules", ["actual", "lb"]], ["backend-services", [`unrelated-${run}`, "lb"]], ["firewall-rules", []]]) {
      const result = spawnSync("jq", ["--arg", "kind", kind, "--arg", "marker", "baskule-ephemeral", "--slurpfile", "runs", join(work, "runs.json"), "--slurpfile", "links", join(work, "links.json"), "--slurpfile", "accounts", join(work, "accounts.json"), "--slurpfile", "addresses", join(work, "addresses.json"), `${filter} [.[] | select(selected) | .name]`, join(work, "resources.json")], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected, kind);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

for (const mode of ["sweep-young-cluster", "sweep-young-repo"]) test(`cloud guard refuses ${mode} without mutation`, () => {
  const { result, calls } = exercise(mode);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /younger than 120 minutes/);
  assert.doesNotMatch(calls, /\b(delete|update|remove-iam-policy-binding)\b/);
});
for (const mode of ["sweep-old", "sweep-force"]) test(`cloud guard permits ${mode}`, () => {
  const { result, calls } = exercise(mode);
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /artifacts repositories delete other-repo/);
});

test("unlabelled forwarding rules recover by owned IP or known run description", () => {
  const driver = readFileSync(join(root, "e2e/kubernetes-ephemeral.sh"), "utf8");
  const filter = driver.split("owned_filter='")[1].split(/'\n\n?kinds=/)[0].trim();
  const run = "baskule-ephemeral-1234-abcd";
  const rules = [
    { name: "ip-match", IPAddress: "192.0.2.1" },
    { name: "description-match", description: `namespace ${run}` },
    { name: "other-ip", IPAddress: "192.0.2.2" },
    { name: `unrelated-${run}`, description: "another installation" },
    { name: "missing-ip" },
  ];
  const result = spawnSync("jq", ["--arg", "kind", "forwarding-rules", "--arg", "marker", "baskule-ephemeral", "--argjson", "runs", JSON.stringify([[run]]), "--argjson", "links", "[[]]", "--argjson", "accounts", "[[]]", "--argjson", "addresses", JSON.stringify([[{ address: "192.0.2.1", labels: { "baskule-ephemeral": "true", "baskule-run": run } }, { address: "192.0.2.2", labels: { owner: "unrelated" } }]]), `${filter} [.[] | select(selected) | .name]`], { encoding: "utf8", input: JSON.stringify(rules) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["ip-match", "description-match"]);
});
