import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
function exercise(mode = "existing") {
  const malformed = mode === "malformed";
  const iam = mode.startsWith("iam");
  mkdirSync(join(root, ".run"), { recursive: true });
  const fixture = mkdtempSync(join(root, ".run/gke-guard-"));
  // Deliberately too long to name a real Google Cloud project.
  const project = `baskule-ephemeral-fixture-not-a-project-${fixture.split("/").at(-1)}`;
  const stateRoot = join(root, ".run/kubernetes-ephemeral");
  mkdirSync(stateRoot, { recursive: true });
  const ownedState = mkdtempSync(join(stateRoot, "gke.fixture-"));
  const email = `bk-fixture@${project}.iam.gserviceaccount.com`;
  const prefix = `https://www.googleapis.com/compute/v1/projects/${project}`;
  try {
    writeFileSync(join(fixture, "clusters.json"), JSON.stringify((malformed || iam) ? [] : [{ name: "other-test", location: "europe-west1-b", resourceLabels: { "baskule-ephemeral": "true", "baskule-run": "another-run" } }]));
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
          *'container clusters list'*) cat "$BASKULE_TEST_FIXTURE/clusters.json" ;;
          *'compute disks list'*) if [[ $BASKULE_TEST_MALFORMED == 1 ]]; then printf 'null\\n'; else printf '[]\\n'; fi ;;
          *'compute instances list'*) cat "$BASKULE_TEST_FIXTURE/instances.json" ;;
          *'iam service-accounts list'*) cat "$BASKULE_TEST_FIXTURE/accounts.json" ;;
          *' list '*) printf '[]\\n' ;;
          *) return 99 ;;
        esac
      }
      export -f gcloud
      bash "$BASKULE_TEST_DRIVER" "$BASKULE_TEST_ACTION"
    `], { cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, BASKULE_GKE_PROJECT: project, BASKULE_TEST_MALFORMED: malformed ? "1" : "0", BASKULE_TEST_ACTION: mode === "iam" ? "sweep" : "run", BASKULE_TEST_FIXTURE: fixture, BASKULE_TEST_DRIVER: join(root, "e2e/kubernetes-ephemeral.sh") } });
    return { result, policy: JSON.parse(readFileSync(join(fixture, "iam.json"), "utf8")), email, calls: readFileSync(join(fixture, "calls"), "utf8") };
  } finally { rmSync(fixture, { recursive: true, force: true }); rmSync(ownedState, { recursive: true, force: true }); }
}

test("an existing ephemeral installation refuses a run without deleting resources", () => {
  const { result, calls } = exercise();
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(calls, /\b(create|delete|update|add-iam-policy-binding|remove-iam-policy-binding)\b/);
  assert.match(result.stderr, /clusters: 1 owned resources/);
  assert.match(result.stderr, /instances: 0 owned resources/);
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
