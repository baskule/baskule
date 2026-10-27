import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { environment, stackIdentity, portlessEnvironment } from "./stack.mjs";

function teardown(t, { entry, node = true, flock = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "osdev-gateway-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), registry = join(root, "run/stacks"), calls = join(root, "docker-calls");
  mkdirSync(bin); mkdirSync(registry, { recursive: true });
  for (const [name, target] of Object.entries({ bash: "/bin/bash", mkdir: "/bin/mkdir", ...(node ? { node: process.execPath } : {}), ...(flock ? { flock: "/usr/bin/flock" } : {}) })) symlinkSync(target, join(bin, name));
  if (!flock) writeFileSync(join(bin, "flock"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(bin, "docker"), '#!/bin/bash\necho "$*" >> "$CALLS"\nif [ "$1" = ps ]; then echo fake-gateway; fi\n', { mode: 0o755 });
  if (entry !== undefined) writeFileSync(join(registry, "stack.json"), entry);
  const result = spawnSync("/bin/bash", ["openshell/dev-down.sh"], { encoding: "utf8", env: { ...process.env, BASKULE_SHARED: root, PATH: bin, CALLS: calls } });
  return { ...result, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}

test("empty registry permits gateway teardown", (t) => {
  const r = teardown(t); assert.equal(r.status, 0, r.stderr); assert.match(r.calls, /rm -f osdev-openshell/);
});
test("registered stacks protect gateway even after their worktree disappears", (t) => {
  const r = teardown(t, { entry: JSON.stringify({ definition: { shared: ["gateway"] }, worktree: "/does-not-exist" }) });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.calls, ""); assert.match(r.stdout, /kept/);
});
for (const [name, options] of Object.entries({ "malformed registry": { entry: "{" }, "invalid registry": { entry: "{}" }, "missing Node": { node: false }, "failed lock": { flock: false } })) {
  test(`${name} cannot tear down shared gateway`, (t) => {
    const r = teardown(t, options); assert.notEqual(r.status, 0); assert.equal(r.calls, "");
  });
}

const stack = { id: "test-instance", ports: { "fake-llm": 12345 }, urls: { loopback: "http://127.0.0.1:12346", front: "https://test.baskule.localhost" }, definition: { env: { FIRST: "${PORT_FAKE_LLM}", SECOND: "${FIRST}" } }, overrides: { THIRD: "${SECOND}", COMPUTERD_INSTANCE: "other" } };
test("profile and --set values resolve runtime ports and references", () => {
  const env = environment(stack);
  for (const key of ["FIRST", "SECOND", "THIRD"]) assert.equal(env[key], "12345");
  assert.equal(env.COMPUTERD_INSTANCE, stack.id);
});
test("unknown profile variable names the missing value", () => {
  assert.throws(() => environment({ ...stack, overrides: { FIRST: "${DOES_NOT_EXIST_U2B}" } }), /unknown variable DOES_NOT_EXIST_U2B/);
});
test("cyclic profile variables fail clearly", () => {
  assert.throws(() => environment({ ...stack, overrides: { FIRST: "${SECOND}" } }), /cycle/);
});

test("gc removes old web builds and keeps recent builds", (t) => {
  const root = mkdtempSync(join(tmpdir(), "osdev-build-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldName = `hosted-web-${"a".repeat(64)}`, recentName = `hosted-web-${"b".repeat(64)}`;
  const old = join(root, "cache/builds", oldName), recent = join(root, "cache/builds", recentName);
  mkdirSync(old, { recursive: true }); mkdirSync(recent, { recursive: true });
  const orphanName = `${oldName}.99999999`, orphan = join(root, "cache/builds", orphanName); mkdirSync(orphan);
  const before = new Date(Date.now() - 8 * 86400_000); utimesSync(old, before, before); utimesSync(orphan, before, before);
  const r = spawnSync(process.execPath, ["scripts/stack.mjs", "gc", "--json"], { encoding: "utf8", env: { ...process.env, BASKULE_SHARED: root } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).builds.sort(), [oldName, orphanName].sort());
  assert(!existsSync(orphan));
  assert(!existsSync(old)); assert(existsSync(recent));
});

test("colliding branch slugs keep separate resource identities", () => {
  const one = stackIdentity("feat/x", "/worktree/one"), two = stackIdentity("feat-x", "/worktree/two");
  assert.equal(one.alias, "feat-x.baskule"); assert.equal(two.alias, one.alias);
  assert.notEqual(one.id, two.id); assert.deepEqual(one, stackIdentity("feat/x", "/worktree/one"));
});
test("gc keeps malformed registry entries without blocking other cleanup", (t) => {
  const root = mkdtempSync(join(tmpdir(), "osdev-bad-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "run/stacks"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "broken.json"), "{");
  const r = spawnSync(process.execPath, ["scripts/stack.mjs", "gc", "--json"], { encoding: "utf8", env: { ...process.env, BASKULE_SHARED: root } });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout).removed, []);
  assert.match(r.stderr, /Keeping unreadable registry/); assert(existsSync(join(dir, "broken.json")));
});

for (const command of [["reload"], ["restart", "celld"]]) test(`${command.join(" ")} refuses a stopped stack without registering or launching`, (t) => {
  const root = mkdtempSync(join(tmpdir(), "osdev-stopped-stack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, ".run/stack"), { recursive: true });
  cpSync("scripts/stack.mjs", join(root, "scripts/stack.mjs"));
  const state = { worktree: root, id: "stopped", phase: "stopped", definition: { services: { celld: {} } }, processes: {} };
  writeFileSync(join(root, ".run/stack/stack.json"), JSON.stringify(state));
  const r = spawnSync(process.execPath, [join(root, "scripts/stack.mjs"), ...command, "--json"], { encoding: "utf8", env: { ...process.env, BASKULE_SHARED: join(root, "shared") } });
  assert.equal(r.status, 1, r.stderr); assert.match(JSON.parse(r.stdout).error, /No running stack/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".run/stack/stack.json"))), state);
  assert(!existsSync(join(root, "shared/run/stacks")));
});

test("runner stack uses the same gateway ports as the component loops", (t) => {
  const previous = { DEV_GATEWAY_PORT: process.env.DEV_GATEWAY_PORT, DEV_VOLUMES_PORT: process.env.DEV_VOLUMES_PORT };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.DEV_GATEWAY_PORT = "47520";
  process.env.DEV_VOLUMES_PORT = "47521";
  const env = environment(stack);
  assert.equal(env.DEV_GATEWAY_PORT, "47520"); assert.equal(env.DEV_VOLUMES_PORT, "47521");
  assert.equal(env.OPENSHELL_GATEWAY, "127.0.0.1:47520");
  assert.equal(env.OPENSHELL_VOLUMES_URL, "http://127.0.0.1:47521");
});

test("--set gateway ports are used by both the gateway and computerd", () => {
  const env = environment({ ...stack, overrides: { DEV_GATEWAY_PORT: "47530", DEV_VOLUMES_PORT: "47531" } });
  assert.equal(env.DEV_GATEWAY_PORT, "47530");
  assert.equal(env.DEV_VOLUMES_PORT, "47531");
  assert.equal(env.OPENSHELL_GATEWAY, "127.0.0.1:47530");
  assert.equal(env.OPENSHELL_VOLUMES_URL, "http://127.0.0.1:47531");
});

test("Portless does not inherit package-runner installation flags", () => {
  const env = { npm_command: "exec", PNPM_SCRIPT_SRC_DIR: "/worktree", PATH: "/bin", npm_lifecycle_event: "test" };
  assert.deepEqual(portlessEnvironment(env), { PATH: "/bin", npm_lifecycle_event: "test" });
  assert.equal(env.npm_command, "exec");
});

test("all local dev profiles share the lease default; explicit values and non-dev modes retain theirs", () => {
  assert.equal(environment({ ...stack, definition: { mode: "dev", env: {} }, overrides: {} }).CELLD_TTL_MS, process.env.CELLD_TTL_MS || "60000");
  assert.equal(environment({ ...stack, definition: { mode: "dev", env: { CELLD_TTL_MS: "90000" } }, overrides: {} }).CELLD_TTL_MS, "90000");
  assert.equal(environment({ ...stack, definition: { mode: "rustfs", env: {} }, overrides: {} }).CELLD_TTL_MS, process.env.CELLD_TTL_MS);
});
