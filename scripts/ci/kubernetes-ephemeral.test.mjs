import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("an existing ephemeral installation refuses a run without deleting resources", () => {
  mkdirSync(join(root, ".run"), { recursive: true });
  const fixture = mkdtempSync(join(root, ".run/gke-guard-"));
  // Deliberately too long to name a real Google Cloud project.
  const project = "baskule-ephemeral-fixture-not-a-project";
  const prefix = `https://www.googleapis.com/compute/v1/projects/${project}`;
  try {
    writeFileSync(join(fixture, "clusters.json"), JSON.stringify([{ name: "other-test", location: "europe-west1-b", resourceLabels: { "baskule-ephemeral": "true", "baskule-run": "another-run" } }]));
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
          *'compute instances list'*) cat "$BASKULE_TEST_FIXTURE/instances.json" ;;
          *'iam service-accounts list'*) cat "$BASKULE_TEST_FIXTURE/accounts.json" ;;
          *' list '*) printf '[]\\n' ;;
          *) return 99 ;;
        esac
      }
      export -f gcloud
      bash "$BASKULE_TEST_DRIVER" run
    `], { cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, BASKULE_GKE_PROJECT: project, BASKULE_TEST_FIXTURE: fixture, BASKULE_TEST_DRIVER: join(root, "e2e/kubernetes-ephemeral.sh") } });
    assert.equal(result.status, 1, result.stderr);
    const calls = readFileSync(join(fixture, "calls"), "utf8");
    assert.doesNotMatch(calls, /\b(create|delete|update|add-iam-policy-binding|remove-iam-policy-binding)\b/, "a refused run must make no mutation attempts");
    assert.match(result.stderr, /clusters: 1 owned resources/);
    assert.match(result.stderr, /instances: 0 owned resources/);
    assert.match(result.stderr, /accounts: 0 owned resources/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
