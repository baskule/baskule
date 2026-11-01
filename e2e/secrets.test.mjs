import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

for (const missing of [false, true]) test(`live suite and infra smoke ${missing ? "refuse missing" : "use generated"} consumer secrets`, () => {
  const work = mkdtempSync(resolve(tmpdir(), "e2e-secrets-"));
  const modules = new URL("./.run/", import.meta.url);
  mkdirSync(modules, { recursive: true });
  const liveModule = new URL(`secrets-${crypto.randomUUID()}.mjs`, modules);
  const source = readFileSync(new URL("./tests/lib.ts", import.meta.url), "utf8")
    .replaceAll("import.meta.dirname", JSON.stringify(resolve(import.meta.dirname, "tests")));
  writeFileSync(liveModule, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText);
  try {
    for (const container of ["baskule-computerd", "baskule-celld-a/storage"]) {
      mkdirSync(resolve(work, container), { recursive: true });
    }
    writeFileSync(resolve(work, "baskule-computerd/secrets"), missing ? "" : 'export COMPUTERD_TOKEN=${COMPUTERD_TOKEN:-generated-computer-token}\n');
    writeFileSync(resolve(work, "baskule-celld-a/storage/secrets"), 'export RUSTFS_ACCESS_KEY=${RUSTFS_ACCESS_KEY:-generated-storage-id}\nexport RUSTFS_SECRET_KEY=${RUSTFS_SECRET_KEY:-generated-storage-secret}\n');
    writeFileSync(resolve(work, "docker"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "exec" && args[2] === "sh") {
  const command = args[4].replaceAll("/run/baskule", process.env.SECRET_FIXTURE + "/" + args[1]);
  const result = spawnSync("sh", ["-ec", command], { encoding: "utf8", env: { PATH: process.env.PATH } });
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}
appendFileSync(process.env.SECRET_CALLS, JSON.stringify(args) + "\\n");
console.log("{}");
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${work}:${process.env.PATH}`, SECRET_FIXTURE: work, SECRET_CALLS: resolve(work, "calls"),
      // Docker exec uses the container environment, so stale host values must stay on the host.
      COMPUTERD_TOKEN: "stale-env-token", RUSTFS_ACCESS_KEY: "stale-env-id", RUSTFS_SECRET_KEY: "stale-env-secret" };
    const live = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { generatedSecret, computerd, cx } from ${JSON.stringify(liveModule.href)};
      assert.equal(generatedSecret("COMPUTERD_TOKEN"), "generated-computer-token");
      assert.equal(generatedSecret("RUSTFS_ACCESS_KEY"), "generated-storage-id");
      assert.equal(generatedSecret("RUSTFS_SECRET_KEY"), "generated-storage-secret");
      computerd("/spaces");
      cx("fixture", "true");
    `], { env, encoding: "utf8" });
    assert.equal(live.status, missing ? 1 : 0, live.stderr);
    if (missing) assert.match(live.stderr, /Command failed: docker exec baskule-computerd sh -ec/);
    if (!missing) {
      const calls = readFileSync(env.SECRET_CALLS, "utf8");
      assert.match(calls, /Authorization: Bearer generated-computer-token/);
      assert.match(calls, /COMPUTERD_TOKEN=generated-computer-token/);
      assert.doesNotMatch(calls, /stale-env/);
    }
    const smokeSource = readFileSync(new URL("./infra-smoke.sh", import.meta.url), "utf8");
    const smoke = smokeSource.slice(smokeSource.indexOf("secret_get()"), smokeSource.indexOf('check "fleet:'));
    const infra = spawnSync("bash", ["-uc", `env_get() { case $1 in S3_REGION) echo us-east-1;; CELLD_BUCKET_NAME) echo fixture;; *) return 1;; esac; }
S3= TAG=fixture
${smoke}
[[ "$COMPUTERD_TOKEN" == generated-computer-token ]]
[[ "$s3_id" == generated-storage-id && "$s3_secret" == generated-storage-secret ]]
`], { env, encoding: "utf8" });
    assert.equal(infra.status, missing ? 1 : 0, infra.stderr);
    assert.equal(infra.stdout, "", "secret reads do not print credentials");
    if (!missing) {
      const calls = readFileSync(env.SECRET_CALLS, "utf8");
      assert.match(calls, /AWS_ACCESS_KEY_ID=generated-storage-id/);
      assert.match(calls, /AWS_SECRET_ACCESS_KEY=generated-storage-secret/);
      assert.doesNotMatch(calls, /stale-env/);
    }
  } finally { rmSync(liveModule, { force: true }); rmSync(work, { recursive: true, force: true }); }
});
