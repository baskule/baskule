import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

function fixture(t) {
  mkdirSync(".run", { recursive: true });
  const dir = mkdtempSync(resolve(".run/worktree-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "main"), shared = join(dir, "shared"), tools = join(shared, "tools");
  const run = (cmd, args, cwd = root) => {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const name of ["worktree", "env.sh", "source-hash.py"]) cpSync(`scripts/${name}`, join(root, "scripts", name));
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "package.json"), '{"packageManager":"pnpm@11.10.0"}');
  writeFileSync(join(root, "app/package.json"), '{}');
  run("git", ["init", "-q"]);
  run("git", ["add", "."]);
  run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]);
  mkdirSync(join(tools, "bin"), { recursive: true });
  mkdirSync(join(tools, "node-v24.22.1-linux-x64/bin"), { recursive: true });
  mkdirSync(join(tools, "pnpm/node_modules/.bin"), { recursive: true });
  mkdirSync(join(tools, "pnpm/node_modules/pnpm"));
  writeFileSync(join(tools, "pnpm/node_modules/pnpm/package.json"), '{"version":"11.10.0"}');
  writeFileSync(join(tools, "bin/celld"), '#!/bin/sh\necho 0.6.3\n', { mode: 0o755 });
  writeFileSync(join(tools, "bin/curl"), '#!/bin/sh\necho "unexpected tool download" >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(tools, "bin/celld.source"), 'ghcr.io/denoland/celld:0.6.3@sha256:22bca1b40a9e4c434cc149d8913d7eaafa9792961a8c05f9fecf921d416216dc\n');
  symlinkSync(process.execPath, join(tools, "node-v24.22.1-linux-x64/bin/node"));
  writeFileSync(join(tools, "pnpm/node_modules/.bin/pnpm"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const store = args[args.indexOf("--store-dir") + 1];
// A second installer must be excluded for the entire package import/build phase.
const lock = spawnSync("flock", ["-n", join(store, ".worktree-install.lock"), "true"]);
if (lock.status !== 1) throw new Error("shared store is not protected from another installer");
if (!args.includes("--config.confirmModulesPurge=false")) throw new Error("headless install would prompt");
appendFileSync(process.env.FIXTURE_CALLS, process.cwd() + "\\n");
if (process.env.FIXTURE_FAIL && process.cwd().endsWith("/app")) process.exit(7);
mkdirSync("node_modules/.bin", { recursive: true });
writeFileSync("node_modules/.bin/vp", "", { mode: 0o755 });
`, { mode: 0o755 });
  symlinkSync(tools, join(root, ".tools"));
  const linked = join(dir, "linked");
  run("git", ["worktree", "add", "--detach", "-q", linked]);
  const calls = join(dir, "calls");
  const env = { ...process.env, FIXTURE_CALLS: calls, HOME: join(dir, "home"), PATH: join(tools, "bin") + ":" + process.env.PATH };
  for (const key of ["BASKULE_SHARED", "BASKULE_PNPM_STORE", "XDG_CACHE_HOME", "npm_config_cache", "pnpm_config_store_dir"]) delete env[key];
  const setup = (cwd, extra = {}) => new Promise((done, reject) => {
    const child = spawn("bash", ["scripts/worktree", "setup"], { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    let output = "";
    child.stdout.on("data", (data) => output += data);
    child.stderr.on("data", (data) => output += data);
    child.on("error", reject);
    child.on("close", (status) => done({ status, output }));
  });
  return { dir, root, linked, shared, calls, setup };
}

test("new worktrees reuse primary tools and exclude concurrent shared-store installers", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.setup(f.root), f.setup(f.linked)]);
  for (const r of results) assert.equal(r.status, 0, r.output);
  assert.equal(readFileSync(f.calls, "utf8").trim().split("\n").length, 4);
  assert.equal(existsSync(join(f.dir, "home/.cache/baskule")), false);
  const again = await f.setup(f.linked);
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /unchanged installation inputs; skipped/);
  assert.equal(readFileSync(f.calls, "utf8").trim().split("\n").length, 5);
});

for (const override of ["environment", "existing tools"]) test(`${override} takes precedence over primary checkout tools`, async (t) => {
  const f = fixture(t), other = join(f.dir, "other");
  cpSync(f.shared, other, { recursive: true });
  if (override === "existing tools") symlinkSync(join(other, "tools"), join(f.linked, ".tools"));
  const r = await f.setup(f.linked, override === "environment" ? { BASKULE_SHARED: other } : {});
  assert.equal(r.status, 0, r.output);
  assert.equal(existsSync(join(other, "cache/pnpm-store/.worktree-install.lock")), true);
  assert.equal(existsSync(join(f.shared, "cache")), false);
});

test("failed app installation reports its error without stamping success", async (t) => {
  const f = fixture(t);
  const r = await f.setup(f.linked, { FIXTURE_FAIL: "1" });
  assert.equal(r.status, 7, r.output);
  assert.match(r.output, /dependencies failed \(exit 7\)/);
  assert.equal(readFileSync(f.calls, "utf8"), f.linked + "\n" + join(f.linked, "app") + "\n");
  assert.equal(existsSync(join(f.linked, "app/node_modules/.baskule-inputs")), false);
});
