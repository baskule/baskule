import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

for (const existing of [false, true]) test(existing
  ? "existing bucket starts without fleet diagnostics while nodes are offline"
  : "bucket bootstrap retries initializing HEAD and PUT until signed HEAD succeeds", () => {
  const work = mkdtempSync(resolve(tmpdir(), "bucket-test-"));
  try {
    writeFileSync(resolve(work, "curl"), `#!/bin/bash
set -eu
[[ "$*" == *--aws-sigv4* ]]
n=$(cat "$MOCK_COUNT" 2>/dev/null || echo 0)
echo $((n + 1)) > "$MOCK_COUNT"
echo "$*" >> "$MOCK_LOG"
if [[ "$MOCK_EXISTING" == yes ]]; then echo 200; exit 0; fi
case $n in 0|1) echo 503 ;; 2) echo 404 ;; 3|4) echo 200 ;; *) exit 99 ;; esac
`, { mode: 0o755 });
    writeFileSync(resolve(work, "celld"), '#!/bin/bash\necho \"Unexpected fleet diagnostic before nodes start\" >&2\nexit 99\n', { mode: 0o755 });
    const result = spawnSync("bash", ["deploy/celld/jobs.sh", "bootstrap"], { encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, MOCK_COUNT: resolve(work, "count"), MOCK_LOG: resolve(work, "requests"),
        MOCK_EXISTING: existing ? "yes" : "no", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", S3_ENDPOINT: "http://storage.test", CELLD_BUCKET_NAME: "test", CELLD_BUCKET: "s3://test" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /bucket test ready/);
    const calls = readFileSync(resolve(work, "requests"), "utf8").trim().split("\n");
    assert.equal(calls.length, existing ? 1 : 5);
    assert.match(calls[0], /-I http:\/\/storage.test\/test$/);
    if (existing) return;
    assert.match(calls[1], /-X PUT http:\/\/storage.test\/test$/);
    assert.match(calls[4], /-I http:\/\/storage.test\/test$/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("setup generates secrets once, preserves overrides, and prints the effective setup link", () => {
  const work = mkdtempSync(resolve(tmpdir(), "setup-test-"));
  try {
    const env = { ...process.env, BASKULE_SECRETS_DIR: work };
    const first = spawnSync("bash", ["deploy/celld/jobs.sh", "setup"], { env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const secrets = readFileSync(resolve(work, "secrets"), "utf8");
    assert.equal(secrets.trim().split("\n").length, 5);
    assert.match(first.stderr, /http:\/\/127.0.0.1:47090\/setup#token=[a-f0-9]{64}/);
    const second = spawnSync("bash", ["deploy/celld/jobs.sh", "setup"], { env: { ...env, SETUP_TOKEN: "override", PUBLIC_URL: "https://example.test" }, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(resolve(work, "secrets"), "utf8"), secrets);
    assert.match(second.stderr, /https:\/\/example.test\/setup#token=override/);
    const override = spawnSync("bash", ["deploy/celld/jobs.sh", "run", "bash", "-c", 'printf "%s\n" "$COMPUTERD_TOKEN" "$OPENSHELL_VOLUMES_TOKEN" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY"'], {
      env: { ...env, COMPUTERD_TOKEN: "computer override", OPENSHELL_VOLUMES_TOKEN: "volume override", S3_ACCESS_KEY: "external key", S3_SECRET_KEY: "external secret" }, encoding: "utf8" });
    assert.equal(override.status, 0, override.stderr);
    assert.equal(override.stdout, "computer override\nvolume override\nexternal key\nexternal secret\n");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

for (const status of ["200", "307", "400", "403"]) test(`deploy readiness accepts an unsigned ${status} answer`, () => {
  const work = mkdtempSync(resolve(tmpdir(), "deploy-ready-test-"));
  try {
    writeFileSync(resolve(work, "curl"), `#!/bin/bash\necho ${status}\n`, { mode: 0o755 });
    const result = spawnSync("bash", ["-c", 'source <(sed -n "/^wait_s3()/,/^}/p" deploy/celld/jobs.sh); wait_s3'], { encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, S3_ENDPOINT: "http://storage.test" } });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
