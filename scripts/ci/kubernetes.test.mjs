import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("kind fixture and bootstrap honor a custom namespace and release without starting a cluster", () => {
  mkdirSync(join(root, ".run"), { recursive: true });
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
  const statements = source.split("\n").filter(line => line.includes("pass(`NetworkPolicy blocks direct") || line.includes("pass(`computer curl permits"));
  assert.equal(statements.length, 2);
  for (const configured of [false, true]) {
    const messages = [];
    const env = configured ? { BASKULE_K8S_S3_FIXTURE: "fixture" } : {};
    for (const statement of statements) new Function("pass", "process", statement)(message => messages.push(message), { env });
    assert.ok(messages.every(message => message.includes("S3") === configured));
  }
});
