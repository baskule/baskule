import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
        BASKULE_SECRETS_DIR: resolve(work, "secrets"), MOCK_EXISTING: existing ? "yes" : "no", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", S3_ENDPOINT: "http://storage.test", CELLD_BUCKET_NAME: "test", CELLD_BUCKET: "s3://test" } });
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

test("consumer secrets preserve each existing key, fill missing keys, and honor overrides", () => {
  const work = mkdtempSync(resolve(tmpdir(), "setup-test-"));
  try {
    writeFileSync(resolve(work, "curl"), '#!/bin/bash\necho 200\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${work}:${process.env.PATH}`, BASKULE_SECRETS_DIR: resolve(work, "volumes"),
      S3_ENDPOINT: "http://storage.test", CELLD_BUCKET_NAME: "test" };
    const run = (command, extra = {}) => spawnSync("bash", ["deploy/celld/jobs.sh", ...command], { env: { ...env, ...extra }, encoding: "utf8" });
    const generate = () => {
      const result = run(["bootstrap"]);
      assert.equal(result.status, 0, result.stderr);
    };
    generate();
    const roles = { storage: ["RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY"], platform: ["COMPUTERD_TOKEN", "SETUP_TOKEN", "PLUGIN_SYNC_TOKEN"],
      computerd: ["COMPUTERD_TOKEN"] };
    const file = role => resolve(env.BASKULE_SECRETS_DIR, role, "secrets");
    const original = Object.fromEntries(Object.keys(roles).map(role => [role, readFileSync(file(role), "utf8")]));
    for (const [role, keys] of Object.entries(roles)) {
      assert.deepEqual(original[role].trim().split("\n").map(line => line.match(/^export ([A-Z_]+)=/)[1]), keys);
    }
    generate();
    for (const role of Object.keys(roles)) assert.equal(readFileSync(file(role), "utf8"), original[role]);
    // A later version's key can be added without replacing any existing default.
    const future = spawnSync("bash", ["-c", "source <(sed '/^case /,$d' deploy/celld/jobs.sh); ensure_secret secrets FUTURE_TOKEN platform"], { env, encoding: "utf8" });
    assert.equal(future.status, 0, future.stderr);
    const extended = readFileSync(file("platform"), "utf8");
    assert.ok(extended.startsWith(original.platform));
    assert.match(extended, /export FUTURE_TOKEN=/);
    // A missing consumer copy recovers the shared key from another role's volume.
    writeFileSync(file("computerd"), original.computerd.split("\n").filter(line => !line.startsWith("export COMPUTERD_TOKEN=")).join("\n"));
    generate();
    const value = (text, key) => text.match(new RegExp(`^export ${key}=.*$`, "m"))[0];
    assert.equal(value(readFileSync(file("computerd"), "utf8"), "COMPUTERD_TOKEN"), value(original.platform, "COMPUTERD_TOKEN"));
    assert.equal(readFileSync(file("platform"), "utf8"), extended);
    const override = run(["run", "bash", "-c", 'printf "%s\n" "$COMPUTERD_TOKEN" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY"'], {
      COMPUTERD_TOKEN: "computer override", S3_ACCESS_KEY: "external key", S3_SECRET_KEY: "external secret" });
    assert.equal(override.status, 0, override.stderr);
    assert.equal(override.stdout, "computer override\nexternal key\nexternal secret\n");
  } finally { rmSync(work, { recursive: true, force: true }); }
});

for (const required of [true, false]) test(`setup prints a link only when the deployed API reports required=${required}`, () => {
  const work = mkdtempSync(resolve(tmpdir(), "setup-link-test-"));
  try {
    writeFileSync(resolve(work, "curl"), `#!/bin/bash\nprintf '%s' '{"required":${required},"password":true}'\n`, { mode: 0o755 });
    const result = spawnSync("bash", ["deploy/celld/jobs.sh", "setup"], { encoding: "utf8", env: { ...process.env,
      PATH: `${work}:${process.env.PATH}`, BASKULE_SECRETS_DIR: work, SETUP_TOKEN: "test-token",
      SETUP_STATUS_URL: "http://node/api/baskule/setup", PUBLIC_URL: "http://127.0.0.1:48090" } });
    assert.equal(result.status, 0, result.stderr);
    if (required) assert.match(result.stderr, /http:\/\/127.0.0.1:48090\/setup#token=test-token/);
    else assert.doesNotMatch(result.stderr, /token=/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

for (const [edge, domain, message] of [
  ["https", "", "BASKULE_DOMAIN is required when BASKULE_EDGE=https"],
  ["HTTPS", "baskule.test", "BASKULE_EDGE must be http or https (lowercase)"],
]) test(`setup rejects invalid edge configuration: ${edge}/${domain}`, () => {
  const work = mkdtempSync(resolve(tmpdir(), "setup-edge-test-"));
  try {
    writeFileSync(resolve(work, "curl"), '#!/bin/bash\necho unexpected-status-query > "$MOCK_LOG"\nexit 99\n', { mode: 0o755 });
    const result = spawnSync("bash", ["deploy/celld/jobs.sh", "setup"], { encoding: "utf8", timeout: 3_000,
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, BASKULE_SECRETS_DIR: work,
        BASKULE_EDGE: edge, BASKULE_DOMAIN: domain, SETUP_STATUS_URL: "http://node/api/baskule/setup",
        MOCK_LOG: resolve(work, "requests") } });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.equal(existsSync(resolve(work, "requests")), false, "reject settings before querying the platform");
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

for (const kubernetes of [false, true]) test(`platform deploy preserves scoped sync secret; Kubernetes readiness=${kubernetes}`, () => {
  const work = mkdtempSync(resolve(tmpdir(), "deploy-no-setup-test-"));
  try {
    const source = resolve(work, "source");
    // Exercise the real deploy branch with a disposable app and offline tools.
    mkdirSync(`${source}/platform`, { recursive: true });
    writeFileSync(`${source}/platform/wrangler.json`, '{"name":"baskule","vars":{}}');
    writeFileSync(`${source}/platform/wrangler.web.json`, '{"name":"baskule-web","vars":{}}');
    writeFileSync(resolve(work, "jobs.sh"), readFileSync("deploy/celld/jobs.sh", "utf8").replaceAll("/src/", `${source}/`).replaceAll("/usr/local/bin/baskule-sync-plugins", resolve(work, "sync")));
    writeFileSync(resolve(work, "celld"), `#!/bin/bash
set -eu
if [[ "$*" == *--named-only* ]]; then
  cp "$2" "$MOCK_WRANGLER"
  echo '{"version":"backend-test-version"}'
else
  test -f "$MOCK_WRANGLER"
  jq -e '.name == "baskule-web" and .vars.BACKEND_VERSION == "backend-test-version" and (.vars | has("PLUGIN_SYNC_TOKEN") | not)' "$2" >/dev/null
fi
`, { mode: 0o755 });
    writeFileSync(resolve(work, "sync"), '#!/bin/bash\n[[ "$PLUGIN_SYNC_TOKEN" == generated-folder-secret ]]\nif [[ "$MOCK_SETUP" == true ]]; then test -f "$MOCK_READY_FILE"; fi\n', { mode: 0o755 });
    mkdirSync(resolve(work, "platform"));
    writeFileSync(resolve(work, "platform/secrets"), 'export PLUGIN_SYNC_TOKEN=generated-folder-secret\n');
    writeFileSync(resolve(work, "curl"), '#!/bin/bash\nif [[ "$*" == *setup* ]]; then if [[ "$MOCK_SETUP" != true ]]; then echo unexpected-setup-request >&2; exit 99; fi; touch "$MOCK_READY_FILE"; echo \'{"required":true}\'; else echo 200; fi\n', { mode: 0o755 });
    const result = spawnSync("bash", [resolve(work, "jobs.sh"), "deploy"], { encoding: "utf8", timeout: 3_000,
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, BASKULE_SECRETS_DIR: work, MOCK_WRANGLER: resolve(work, "deployed.json"),
        S3_ENDPOINT: "http://storage.test", CELLD_BUCKET: "s3://test", SETUP_TOKEN: "test-token", SETUP_STATUS_URL: "", PLATFORM_READY_URL: kubernetes ? "http://platform.test/api/baskule/setup" : "", MOCK_SETUP: String(kubernetes), MOCK_READY_FILE: resolve(work, "ready"), CELLD_NODES_INTERNAL: "" } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stderr.includes(`deployed platform`));
    assert.equal(JSON.parse(readFileSync(resolve(work, "deployed.json"), "utf8")).vars.PLUGIN_SYNC_TOKEN, "generated-folder-secret");
    assert.doesNotMatch(result.stdout + result.stderr, /setup|token=|test-token/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});


test("a failed backend publication cannot activate the web Worker or reload nodes", () => {
  const work = mkdtempSync(resolve(tmpdir(), "deploy-stage-failure-"));
  try {
    const source = resolve(work, "source");
    mkdirSync(`${source}/platform`, { recursive: true });
    writeFileSync(`${source}/platform/wrangler.json`, '{"name":"baskule","vars":{}}');
    writeFileSync(`${source}/platform/wrangler.web.json`, '{"name":"baskule-web"}');
    writeFileSync(resolve(work, "jobs.sh"), readFileSync("deploy/celld/jobs.sh", "utf8").replaceAll("/src/", `${source}/`));
    writeFileSync(resolve(work, "celld"), `#!/bin/bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
exit 42
`, { mode: 0o755 });
    writeFileSync(resolve(work, "curl"), `#!/bin/bash
if [[ "$*" == *reload* ]]; then echo reload >> "$MOCK_CALLS"; exit 99; fi
echo 200
`, { mode: 0o755 });
    const result = spawnSync("bash", [resolve(work, "jobs.sh"), "deploy"], { encoding: "utf8", timeout: 3_000,
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, BASKULE_SECRETS_DIR: work,
        MOCK_CALLS: resolve(work, "calls"), S3_ENDPOINT: "http://storage.test", CELLD_BUCKET: "s3://test", CELLD_NODES_INTERNAL: "node:47092" } });
    assert.equal(result.status, 42, result.stderr);
    const calls = readFileSync(resolve(work, "calls"), "utf8").trim().split("\n");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /--named-only/);
    assert.doesNotMatch(calls[0], /wrangler.web/);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
