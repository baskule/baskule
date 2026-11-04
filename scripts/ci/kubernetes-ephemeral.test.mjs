import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
function exercise(mode = "existing") {
  const malformed = mode === "malformed";
  const createFailure = mode === "create-tag-fail";
  const failure = mode.startsWith("sweep-") && mode.includes("-fail");
  const iam = mode.startsWith("iam") || failure;
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
    const created = new Date(Date.now() - (mode.includes("old") ? 121 : 5) * 60_000).toISOString();
    const labels = { "baskule-ephemeral": "true", "baskule-run": "another-run" };
    writeFileSync(join(fixture, "clusters.json"), JSON.stringify(sweeping ? ((mode.includes("cluster") || failure) ? [{ name: "other-test", location: "europe-west1-b", resourceLabels: labels, createTime: created }] : []) : (malformed || iam || createFailure) ? [] : [{ name: "other-test", location: "europe-west1-b", resourceLabels: labels }]));
    writeFileSync(join(fixture, "repositories.json"), JSON.stringify(sweeping && (failure || (!mode.includes("cluster") && !mode.includes("bucket"))) ? [{ name: "other-repo", labels, createTime: created }] : []));
    const bucket = "baskule-ephemeral-1234-abcd";
    writeFileSync(join(fixture, "buckets.json"), JSON.stringify(mode.includes("bucket") ? [{ Name: bucket, CreationDate: created }, { Name: "unrelated-bucket", CreationDate: created }] : []));
    writeFileSync(join(fixture, "bucket.json"), JSON.stringify(mode.includes("untagged") ? { Tags: null } : { Tags: [{ Key: "baskule-ephemeral", Value: "true" }, { Key: "baskule-run", Value: bucket }] }));
    writeFileSync(join(fixture, "instances.json"), JSON.stringify([{ name: "unrelated-vm", selfLink: `${prefix}/zones/europe-west1-b/instances/unrelated-vm`, zone: "europe-west1-b" }]));
    writeFileSync(join(fixture, "accounts.json"), JSON.stringify([{ name: `projects/${project}/serviceAccounts/default`, email: `default@${project}.iam.gserviceaccount.com`, displayName: "Compute Engine default service account" }, ...(failure ? [{ name: `projects/${project}/serviceAccounts/owned`, email }] : [])]));
    writeFileSync(join(fixture, "iam.json"), JSON.stringify({ bindings: iam ? [{ role: "roles/container.defaultNodeServiceAccount", members: [failure ? `serviceAccount:${email}` : `deleted:serviceAccount:${email}?uid=1`, `serviceAccount:other-${email}`] }] : [] }));
    writeFileSync(join(ownedState, "project.private"), project);
    writeFileSync(join(ownedState, "known-accounts.private.json"), JSON.stringify(iam ? [email] : []));
    writeFileSync(join(ownedState, "owned-links.private.json"), "[]");
    if (mode.includes("untagged") && !mode.includes("unrecorded")) {
      writeFileSync(join(ownedState, "scw-project.private"), "fixture");
      writeFileSync(join(ownedState, "known-buckets.private.json"), JSON.stringify([bucket]));
    }
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
          *'iam service-accounts delete'*)
            jq --arg email '${email}' 'map(select(.email != $email))' "$BASKULE_TEST_FIXTURE/accounts.json" > "$BASKULE_TEST_FIXTURE/accounts.next"
            mv "$BASKULE_TEST_FIXTURE/accounts.next" "$BASKULE_TEST_FIXTURE/accounts.json" ;;
          *'iam service-accounts list'*) cat "$BASKULE_TEST_FIXTURE/accounts.json" ;;
          *' list '*) printf '[]\\n' ;;
          *) return 99 ;;
        esac
      }
      scw() {
        printf '%s\\n' "scw $*" >> "$BASKULE_TEST_FIXTURE/calls"
        case "$*" in
          'object bucket list '*) if [[ $BASKULE_TEST_MODE == *scaleway-fail* ]]; then echo 'Scaleway unavailable' >&2; return 1; fi; cat "$BASKULE_TEST_FIXTURE/buckets.json" ;;
          'object bucket create '*)
            jq -n --arg name "$4" '[{Name:$name,CreationDate:"2020-01-01T00:00:00Z"}]' > "$BASKULE_TEST_FIXTURE/buckets.json"
            printf '{"Tags":null}' > "$BASKULE_TEST_FIXTURE/bucket.json"
            echo 'Tagging failed after bucket creation' >&2; return 1 ;;
          'object bucket get baskule-ephemeral-'*) cat "$BASKULE_TEST_FIXTURE/bucket.json" ;;
          'object bucket delete baskule-ephemeral-'*) if [[ $BASKULE_TEST_MODE == *delete-fail* ]]; then return 1; fi; printf '[]\\n' > "$BASKULE_TEST_FIXTURE/buckets.json" ;;
          *) return 99 ;;
        esac
      }
      python3() {
        if [[ $1 == - && $2 == baskule-ephemeral-* && $3 == fr-par ]]; then
          cat >/dev/null
          printf 'empty owned bucket\\n' >> "$BASKULE_TEST_FIXTURE/calls"
          if [[ $BASKULE_TEST_MODE == *empty-fail* ]]; then return 1; fi
        elif [[ $* == '-c import boto3' ]]; then :
        else command python3 "$@"; fi
      }
      helm() { :; }; docker-credential-gcloud() { :; }
      export -f gcloud scw python3 helm docker-credential-gcloud
      if [[ "$BASKULE_TEST_MODE" == live ]]; then
        flock "$BASKULE_TEST_LOCK" bash "$BASKULE_TEST_DRIVER" sweep
      else
        if [[ "$BASKULE_TEST_MODE" == sweep-force ]]; then
          bash "$BASKULE_TEST_DRIVER" sweep --force
        else
          bash "$BASKULE_TEST_DRIVER" "$BASKULE_TEST_ACTION"
        fi
      fi
    `], { cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, SCW_DEFAULT_PROJECT_ID: "fixture", SCW_ACCESS_KEY: "fixture", SCW_SECRET_KEY: "fixture", BASKULE_S3_ACCESS_KEY: "application-access", BASKULE_S3_SECRET_KEY: "application-secret", BASKULE_GKE_PROJECT: project, BASKULE_TEST_LOCK: lock, BASKULE_TEST_MODE: mode, BASKULE_TEST_MALFORMED: malformed ? "1" : "0", BASKULE_TEST_ACTION: mode === "iam" || sweeping ? "sweep" : "run", BASKULE_TEST_FIXTURE: fixture, BASKULE_TEST_DRIVER: join(root, "e2e/kubernetes-ephemeral.sh") } });
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

for (const mode of ["sweep-young-cluster", "sweep-young-repo", "sweep-young-bucket", "sweep-young-bucket-untagged"]) test(`cloud guard refuses ${mode} without mutation`, () => {
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

test("a tagged Scaleway bucket refuses a new run without deleting it", () => {
  const { result, calls } = exercise("bucket-refuse");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /buckets: 1 owned resources/);
  assert.doesNotMatch(calls, /bucket delete|empty owned bucket/);
  assert.doesNotMatch(calls, /bucket get unrelated-bucket/);
});

test("expired Scaleway sweep empties and deletes only a tagged run bucket", () => {
  const { result, calls } = exercise("sweep-old-bucket");
  assert.equal(result.status, 0, result.stderr);
  assert.match(calls, /empty owned bucket\nscw object bucket delete baskule-ephemeral-1234-abcd/);
  assert.doesNotMatch(calls, /bucket (get|delete) unrelated-bucket/);
  assert.match(result.stdout, /buckets: 0 owned resources/);
});

for (const versioning of ["unset", "Suspended", "Enabled"]) test(`S3 cleanup handles ${versioning} versioning without touching other buckets`, () => {
  const driver = readFileSync(join(root, "e2e/kubernetes-ephemeral.sh"), "utf8");
  const python = driver.split("<<'PYBUCKET'\n")[1].split("\nPYBUCKET")[0];
  const prelude = `
import json, sys, types
class ClientError(Exception):
    pass
sys.modules['botocore.exceptions'] = types.SimpleNamespace(ClientError=ClientError)
calls = []
class Store:
    def get_bucket_tagging(self, **kw):
        assert kw == {'Bucket': 'baskule-ephemeral-1234-abcd'}
        return {'TagSet': [{'Key':'baskule-ephemeral','Value':'true'}, {'Key':'baskule-run','Value':'baskule-ephemeral-1234-abcd'}]}
    def get_bucket_versioning(self, **kw):
        return {} if versioning == 'unset' else {'Status': versioning}
    def get_paginator(self, operation):
        self.operation = operation
        return self
    def paginate(self, **kw):
        assert kw == {'Bucket': 'baskule-ephemeral-1234-abcd'}
        return [{'Versions':[{'Key':'lease','VersionId':'null'},{'Key':'data','VersionId':'old'}], 'DeleteMarkers':[{'Key':'removed','VersionId':'marker'}]}] if self.operation == 'list_object_versions' else [{'Uploads':[{'Key':'partial','UploadId':'upload'}]}]
    def delete_objects(self, **kw):
        calls.append(['delete', kw])
        return {}
    def abort_multipart_upload(self, **kw):
        calls.append(['abort', kw])
def client(*args, **kw):
    assert kw['endpoint_url'] == 'https://s3.fr-par.scw.cloud'
    return Store()
sys.modules['boto3'] = types.SimpleNamespace(client=client)
versioning = sys.argv.pop()
`;
  // The fixture supplies only the S3 boundary. Execute the real cleanup body.
  const result = spawnSync("python3", ["-", "baskule-ephemeral-1234-abcd", "fr-par", "false", versioning], {
    input: prelude + python + "\nprint(json.dumps(calls))\n",
    encoding: "utf8", env: { ...process.env, SCW_ACCESS_KEY: "fixture", SCW_SECRET_KEY: "fixture" },
  });
  if (versioning === "Enabled") {
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  } else {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      ["delete", { Bucket: "baskule-ephemeral-1234-abcd", Delete: { Objects: [{ Key: "lease", VersionId: "null" }, { Key: "data", VersionId: "old" }, { Key: "removed", VersionId: "marker" }], Quiet: true } }],
      ["abort", { Bucket: "baskule-ephemeral-1234-abcd", Key: "partial", UploadId: "upload" }],
    ]);
  }
});

test("an inventory failure in the real EXIT-trap sweep cannot report cleanup success", () => {
  const work = mkdtempSync(join(root, ".run/gke-exit-cleanup-"));
  try {
    const driver = readFileSync(join(root, "e2e/kubernetes-ephemeral.sh"), "utf8");
    const sweep = driver.slice(driver.indexOf("sweep() {"), driver.indexOf("guard_recent_runs() {"));
    const cleanup = driver.slice(driver.indexOf("cleanup() {"), driver.indexOf("if ! audit >"));
    const result = spawnSync("bash", ["-c", `
      set -euo pipefail
      run_id=baskule-ephemeral-1-abcd; project=fixture; region=europe-west1; zone=europe-west1-b
      state=$1; BASKULE_K8S_EVIDENCE=$1; KUBECONFIG=$1/missing; DOCKER_CONFIG=$1/docker
      started=$(date +%s); nodes_started=0
      inventory() { return 1; }; owned() { :; }; gc() { printf '[]'; }; python3() { :; }
      ${sweep}
      ${cleanup}
      trap cleanup EXIT
      true
    `, "bash", work], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(readFileSync(join(work, "cost.txt"), "utf8"), /cleanup_status=1/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

for (const failure of ["empty-fail", "delete-fail", "scaleway-fail"]) test(`Scaleway ${failure} still cleans GCP and audits before returning failure`, () => {
  const mode = failure === "scaleway-fail" ? "sweep-old-scaleway-fail" : `sweep-old-bucket-${failure}`;
  const { result, calls, policy, email } = exercise(mode);
  assert.equal(result.status, 1, result.stderr);
  assert.match(calls, /container clusters delete other-test/);
  assert.match(calls, /artifacts repositories delete other-repo/);
  assert.match(calls, /projects remove-iam-policy-binding/);
  assert.match(calls, /iam service-accounts delete/);
  assert.deepEqual(policy.bindings[0].members, [`serviceAccount:other-${email}`]);
  assert.match(result.stdout, /accounts: 0 owned resources/);
  assert.match(result.stdout, /iam-bindings: 0 owned references/);
  assert.ok(calls.lastIndexOf("scw object bucket list") > calls.indexOf("iam service-accounts delete"), "audit runs after IAM cleanup");
  if (failure === "scaleway-fail") assert.match(result.stdout, /buckets: inventory unavailable; absence is unverified/);
  else assert.match(result.stdout, /buckets: 1 owned resources/);
});

test("a recorded exact-name untagged bucket is audited and swept after an interrupted create/tag", () => {
  const refused = exercise("bucket-untagged-refuse");
  assert.equal(refused.result.status, 1, refused.result.stderr);
  assert.match(refused.result.stderr, /buckets: 1 owned resources/);
  assert.doesNotMatch(refused.calls, /bucket delete/);
  const swept = exercise("sweep-old-bucket-untagged");
  assert.equal(swept.result.status, 0, swept.result.stderr);
  assert.match(swept.calls, /empty owned bucket\nscw object bucket delete baskule-ephemeral-1234-abcd/);
  assert.doesNotMatch(swept.calls, /bucket (get|delete) unrelated-bucket/);
  assert.match(swept.result.stdout, /buckets: 0 owned resources/);
});

test("missing cluster application credentials fail before any cloud command", () => {
  for (const missing of ["BASKULE_S3_ACCESS_KEY", "BASKULE_S3_SECRET_KEY"]) {
    const result = spawnSync("bash", ["e2e/kubernetes-ephemeral.sh", "run"], {
      cwd: root, encoding: "utf8", env: { ...process.env, BASKULE_S3_ACCESS_KEY: "app-access", BASKULE_S3_SECRET_KEY: "app-secret", [missing]: "" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(missing));
    assert.doesNotMatch(result.stderr, /gcloud|Scaleway unavailable/);
  }
});

test("the real Secret pipeline creates only application credentials without last-applied metadata", () => {
  const work = mkdtempSync(join(root, ".run/gke-secret-"));
  try {
    const driver = readFileSync(join(root, "e2e/kubernetes-ephemeral.sh"), "utf8");
    const pipeline = driver.slice(driver.indexOf("python3 - <<'PYSECRET'"), driver.indexOf("\nPYSECRET") + "\nPYSECRET".length);
    const result = spawnSync("bash", ["-c", `
      set -euo pipefail
      run_id=fixture
      kubectl() { printf '%s\\n' "$*" > "$OUTPUT/args"; cat > "$OUTPUT/secret.json"; }
      ${pipeline}
    `], { cwd: work, encoding: "utf8", env: { ...process.env, OUTPUT: work, SCW_ACCESS_KEY: "operator-access", SCW_SECRET_KEY: "operator-secret", BASKULE_S3_ACCESS_KEY: "app-access", BASKULE_S3_SECRET_KEY: "app-secret" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(work, "args"), "utf8"), /-n fixture create -f -/);
    const secret = JSON.parse(readFileSync(join(work, "secret.json"), "utf8"));
    assert.equal(secret.metadata.annotations, undefined);
    assert.deepEqual(Object.fromEntries(Object.entries(secret.data).map(([k, v]) => [k, Buffer.from(v, "base64").toString()])), { AWS_ACCESS_KEY_ID: "app-access", AWS_SECRET_ACCESS_KEY: "app-secret" });
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("the S3 cleanup body accepts missing tags only for a recorded exact run name", () => {
  const driver = readFileSync(join(root, "e2e/kubernetes-ephemeral.sh"), "utf8");
  const python = driver.split("<<'PYBUCKET'\n")[1].split("\nPYBUCKET")[0];
  const prelude = `
import sys, types
class ClientError(Exception):
    response = {'Error': {'Code': 'NoSuchTagSet'}}
class Store:
    def get_bucket_tagging(self, **kw): raise ClientError()
    def get_bucket_versioning(self, **kw): return {'Status': 'Suspended'}
    def get_paginator(self, operation): return self
    def paginate(self, **kw): return []
sys.modules['botocore.exceptions'] = types.SimpleNamespace(ClientError=ClientError)
sys.modules['boto3'] = types.SimpleNamespace(client=lambda *a, **kw: Store())
`;
  for (const recorded of ["true", "false"]) {
    const result = spawnSync("python3", ["-", "baskule-ephemeral-1234-abcd", "fr-par", recorded], {
      input: prelude + python + "\nprint('empty complete')\n", encoding: "utf8",
      env: { ...process.env, SCW_ACCESS_KEY: "fixture", SCW_SECRET_KEY: "fixture" },
    });
    if (recorded === "true") { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /empty complete/); }
    else { assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); }
  }
});

test("kind fixture and bootstrap honor a custom namespace and release without starting a cluster", () => {
  const work = mkdtempSync(join(root, ".run/kind-config-"));
  try {
    mkdirSync(join(work, "scripts")); mkdirSync(join(work, "e2e"));
    writeFileSync(join(work, "scripts/env.sh"), "true\n");
    for (const file of ["kubernetes-local.sh", "kubernetes-rustfs.yaml"]) writeFileSync(join(work, "e2e", file), readFileSync(join(root, "e2e", file)));
    const result = spawnSync("bash", ["-c", `
      set -euo pipefail
      helm() { :; }; kind() { :; }; docker() { :; }
      kubectl() {
        printf '%s\\n' "$*" >> "$OUTPUT/calls"
        if [[ $* == '-n review-ns apply -f -' ]]; then cat > "$OUTPUT/fixture.yaml"; fi
      }
      bash() {
        if [[ $1 == e2e/kubernetes-install.sh ]]; then
          printf '%s %s\\n' "$BASKULE_K8S_NAMESPACE" "$BASKULE_K8S_RELEASE" > "$OUTPUT/install-env"
        else command bash "$@"; fi
      }
      export -f helm kind docker kubectl bash
      command bash e2e/kubernetes-local.sh
    `], { cwd: work, encoding: "utf8", env: { ...process.env, OUTPUT: work, BASKULE_K8S_NAMESPACE: "review-ns", BASKULE_K8S_RELEASE: "review-release", BASKULE_K8S_VALUES: join(work, "values.yaml") } });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(join(work, "calls"), "utf8");
    assert.match(calls, /create namespace review-ns/);
    assert.match(calls, /--labels=app.kubernetes.io\/instance=review-release,app.kubernetes.io\/component=deploy/);
    assert.match(calls, /-n review-ns get events/);
    assert.doesNotMatch(calls, /-n baskule|create namespace baskule/);
    assert.match(readFileSync(join(work, "fixture.yaml"), "utf8"), /app.kubernetes.io\/instance: review-release/);
    assert.equal(readFileSync(join(work, "install-env"), "utf8"), "review-ns review-release\n");
    assert.match(readFileSync(join(work, "values.yaml"), "utf8"), /existingSecret: rustfs-fixture/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("network denial messages mention S3 only when the fixture is configured", () => {
  const source = readFileSync(join(root, "e2e/kubernetes-journey.mjs"), "utf8");
  const statements = source.split("\n").filter(line => line.includes("pass(`NetworkPolicy blocks direct") || line.includes("pass(`supervisor-mediated curl"));
  assert.equal(statements.length, 2);
  for (const configured of [false, true]) {
    const messages = [];
    const env = configured ? { BASKULE_K8S_S3_FIXTURE: "fixture" } : {};
    for (const statement of statements) new Function("pass", "process", statement)(message => messages.push(message), { env });
    assert.ok(messages.every(message => message.includes("S3") === configured));
  }
});

test("a create/tag failure cleans the exact untagged bucket through the real EXIT trap", () => {
  const { result, calls } = exercise("create-tag-fail");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Tagging failed after bucket creation/);
  const created = calls.match(/scw object bucket create (baskule-ephemeral-[0-9]+-[a-f0-9]{4}) /)?.[1];
  assert.ok(created);
  assert.ok(calls.includes(`scw object bucket delete ${created} `));
  assert.doesNotMatch(calls, /artifacts repositories create|container clusters create|iam service-accounts create/);
});

test("an unrecorded untagged lookalike bucket is never deleted", () => {
  const { result, calls } = exercise("sweep-old-bucket-untagged-unrecorded");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /buckets: 0 owned resources/);
  assert.doesNotMatch(calls, /empty owned bucket|bucket delete/);
});
