import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
function exercise(malformed = false) {
  mkdirSync(join(root, ".run"), { recursive: true });
  const fixture = mkdtempSync(join(root, ".run/gke-guard-"));
  // Deliberately too long to name a real Google Cloud project.
  const project = "baskule-ephemeral-fixture-not-a-project";
  const prefix = `https://www.googleapis.com/compute/v1/projects/${project}`;
  try {
    writeFileSync(join(fixture, "clusters.json"), JSON.stringify(malformed ? [] : [{ name: "other-test", location: "europe-west1-b", resourceLabels: { "baskule-ephemeral": "true", "baskule-run": "another-run" } }]));
    writeFileSync(join(fixture, "instances.json"), JSON.stringify([{ name: "unrelated-vm", selfLink: `${prefix}/zones/europe-west1-b/instances/unrelated-vm`, zone: "europe-west1-b" }]));
    writeFileSync(join(fixture, "accounts.json"), JSON.stringify([{ name: `projects/${project}/serviceAccounts/default`, email: `default@${project}.iam.gserviceaccount.com`, displayName: "Compute Engine default service account" }]));
    // Exported Bash functions take precedence over any installed SDK. Every
    // unexpected command fails; this test never invokes the real cloud client.
    const result = spawnSync("bash", ["-c", `
      gcloud() {
        printf '%s\\n' "$*" >> "$BASKULE_TEST_FIXTURE/calls"
        case "$*" in
          'config get-value project') printf '%s\\n' "$BASKULE_GKE_PROJECT" ;;
          *'container clusters list'*) cat "$BASKULE_TEST_FIXTURE/clusters.json" ;;
          *'compute disks list'*) if [[ $BASKULE_TEST_MALFORMED == 1 ]]; then printf 'null\\n'; else printf '[]\\n'; fi ;;
          *'compute instances list'*) cat "$BASKULE_TEST_FIXTURE/instances.json" ;;
          *'iam service-accounts list'*) cat "$BASKULE_TEST_FIXTURE/accounts.json" ;;
          *' list '*) printf '[]\\n' ;;
          *) return 99 ;;
        esac
      }
      export -f gcloud
      bash "$BASKULE_TEST_DRIVER" run
    `], { cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, BASKULE_GKE_PROJECT: project, BASKULE_TEST_MALFORMED: malformed ? "1" : "0", BASKULE_TEST_FIXTURE: fixture, BASKULE_TEST_DRIVER: join(root, "e2e/kubernetes-ephemeral.sh") } });
    return { result, calls: readFileSync(join(fixture, "calls"), "utf8") };
  } finally { rmSync(fixture, { recursive: true, force: true }); }
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
  const { result, calls } = exercise(true);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Resource inventory must contain arrays/);
  assert.doesNotMatch(calls, /\b(create|delete|update|add-iam-policy-binding|remove-iam-policy-binding)\b/);
  assert.doesNotMatch(result.stderr, /disks: 0 owned resources/);
});
