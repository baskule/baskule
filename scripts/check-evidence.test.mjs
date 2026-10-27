import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("./", import.meta.url));
function fixture(t, recordEvidence = "1") {
  const directory = mkdtempSync(join(tmpdir(), "osdev-evidence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo"), origin = join(directory, "origin.git");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  function git(...args) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "--bare", "-q", origin);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Evidence test");
  git("config", "user.email", "evidence@test.invalid");
  git("remote", "add", "origin", origin);
  for (const name of ["check.mjs", "check-lock.mjs", "feature-map.mjs", "run-feature.mjs"]) cpSync(join(scripts, name), join(repo, "scripts", name));
  const map = join(repo, ".agents/skills/verify-baskule/features");
  mkdirSync(map, { recursive: true });
  for (const [name, command] of [["first", "mkdir -p .run && printf x >> .run/hits"], ["mutator", "printf changed > platform/input.txt && git add platform/input.txt && git commit -qm changed"]]) {
    writeFileSync(join(map, `${name}.md`), `---\npaths: ["platform/**"]\njourneys: null\nprofile: "full"\nchecks: ${JSON.stringify([command])}\n---\n`);
  }
  mkdirSync(join(repo, "platform"));
  writeFileSync(join(repo, "platform/input.txt"), "initial");
  git("add", "."); git("commit", "-qm", "initial");
  const initial = git("rev-parse", "HEAD");
  return { repo, initial, git, map, run: (...args) => {
    const result = spawnSync(process.execPath, [join(repo, "scripts/check.mjs"), ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_TRACE: join(directory, "git-trace"), BASKULE_CHECK_RECORD: recordEvidence } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  } };
}

test("a pass is kept for unchanged feature inputs", (t) => {
  const f = fixture(t);
  f.run("feature:first", "--fresh");
  assert.match(f.run("feature:first"), /kept/);
  assert.equal(readFileSync(join(f.repo, ".run/hits"), "utf8"), "x");
});

test("hosted checks do not read or write remote evidence", (t) => {
  const f = fixture(t, "0");
  f.run("feature:first", "--fresh");
  assert.equal(f.git("ls-remote", "origin", "refs/evidence/*"), "");
  f.git("remote", "set-url", "origin", "/does-not-exist/baskule-evidence.git");
  const output = f.run("feature:first");
  assert.equal(readFileSync(join(f.repo, ".run/hits"), "utf8"), "xx");
  assert.doesNotMatch(output, /kept|could not record/);
  assert.doesNotMatch(readFileSync(join(f.repo, "../git-trace"), "utf8"), /built-in: git (?:ls-remote|push)\b/);
});

test("fresh runs do not record changed inputs or move earlier evidence onto a later tree", (t) => {
  const f = fixture(t);
  const output = f.run("feature:first", "feature:mutator", "--fresh");
  const refs = f.git("ls-remote", "origin", "refs/evidence/*").split("\n");
  assert.equal(refs.length, 1, output);
  assert.match(refs[0], /refs\/evidence\/feature-first\//);
  assert.equal(refs[0].split("\t")[0], f.initial, output);
  assert.match(output, /inputs changed/);
});

test("a failed check that changes inputs cannot reuse an earlier pass", (t) => {
  const f = fixture(t);
  const file = join(f.map, "mutator.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("git commit -qm changed", "git commit -qm changed && false"));
  f.git("add", "."); f.git("commit", "-qm", "failure scenario");
  f.run("feature:first", "--fresh");
  const result = spawnSync(process.execPath, [join(f.repo, "scripts/check.mjs"), "feature:mutator", "feature:first"], { cwd: f.repo, encoding: "utf8", env: { ...process.env, BASKULE_CHECK_RECORD: "1" } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.repo, ".run/hits"), "utf8"), "xx", result.stdout);
});

test("nested feature checks can keep the earlier pass from this invocation", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.map, "nested.md"), '---\npaths: ["platform/**"]\njourneys: null\nprofile: "full"\nchecks: ["node scripts/check.mjs feature:first"]\n---\n');
  f.git("add", "."); f.git("commit", "-qm", "nested feature");
  const output = f.run("feature:first", "feature:nested");
  assert.equal(readFileSync(join(f.repo, ".run/hits"), "utf8"), "x", output);
  assert.match(output, /kept/);
});

test("a mapped custom check can acquire the parent's released gateway lock", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo, "computerd/v2/test"), { recursive: true });
  mkdirSync(join(f.repo, "fake-bin"));
  writeFileSync(join(f.repo, "computerd/v2/test/integration.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(f.repo, "fake-bin/docker"), "#!/bin/sh\nprintf true\n", { mode: 0o755 });
  writeFileSync(join(f.map, "first.md"), '---\npaths: ["platform/**"]\njourneys: null\nprofile: "full"\nchecks: ["flock --nonblock .run/locks/gateway.lock true"]\n---\n');
  f.git("add", "."); f.git("commit", "-qm", "gateway handoff");
  const result = spawnSync(process.execPath, [join(f.repo, "scripts/check.mjs"), "computerd", "feature:first"], {
    cwd: f.repo, encoding: "utf8",
    env: { ...process.env, BASKULE_CHECK_RECORD: "1", PATH: `${join(f.repo, "fake-bin")}:${process.env.PATH}`, BASKULE_CHECK_LOCK_DIR: join(f.repo, ".run/locks") },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.indexOf("released host lock gateway") < result.stdout.indexOf("▶ feature:first"), result.stdout);
});
