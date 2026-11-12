import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupComputers, environment, stackIdentity, portlessEnvironment, stackProxy, stackWorkerConfigs, celldRecipe } from "./stack.mjs";

const stack = { id: "test-instance", ports: { "fake-llm": 12345 }, urls: { loopback: "http://127.0.0.1:12346", front: "https://test.baskule.localhost" }, definition: { env: { FIRST: "${PORT_FAKE_LLM}", SECOND: "${FIRST}" } }, overrides: { THIRD: "${SECOND}", COMPUTERD_INSTANCE: "other" } };
test("profile and --set values resolve runtime ports and references", () => {
  const env = environment(stack);
  for (const key of ["FIRST", "SECOND", "THIRD"]) assert.equal(env[key], "12345");
  assert.equal(env.COMPUTERD_INSTANCE, stack.id);
  assert.equal(env.CELLD_IDLE_EVICT_S, process.env.CELLD_IDLE_EVICT_S ?? "900");
  assert.equal(environment({ ...stack, definition: { env: { CELLD_IDLE_EVICT_S: "1200" } }, overrides: {} }).CELLD_IDLE_EVICT_S, "1200");
  assert.equal(environment({ ...stack, definition: { env: { CELLD_IDLE_EVICT_S: "1200" } }, overrides: { CELLD_IDLE_EVICT_S: "0" } }).CELLD_IDLE_EVICT_S, "0");
});
test("unknown profile variable names the missing value", () => {
  assert.throws(() => environment({ ...stack, overrides: { FIRST: "${DOES_NOT_EXIST_U2B}" } }), /unknown variable DOES_NOT_EXIST_U2B/);
});
test("cyclic profile variables fail clearly", () => {
  assert.throws(() => environment({ ...stack, overrides: { FIRST: "${SECOND}" } }), /cycle/);
});

test("worker configs preserve backend identity and keep secrets out of the public worker", () => {
  const backend = JSON.parse(readFileSync("platform/wrangler.json"));
  const web = JSON.parse(readFileSync("platform/wrangler.web.json"));
  const s = { ...stack, setupToken: "setup-secret", authSecret: "auth-secret", pluginSyncToken: "plugin-secret", computerdToken: "computer-secret" };
  const configs = stackWorkerConfigs(s, environment(s), backend, web);
  assert.equal(configs.backend.name, "baskule-dev-test-instance");
  assert.equal(configs.backend.main, "runtime/index.js");
  assert.deepEqual(configs.backend.durable_objects, backend.durable_objects);
  assert.deepEqual(configs.backend.migrations, backend.migrations);
  assert.equal(configs.web.name, "baskule-web-test-instance");
  assert.equal(configs.web.main, "web-worker/index.js");
  assert.equal(configs.web.assets.directory, "web");
  assert.deepEqual(configs.web.services, [{ binding: "BACKEND", service: configs.backend.name }]);
  assert.equal(configs.web.durable_objects, undefined);
  for (const secret of [s.setupToken, s.authSecret, s.pluginSyncToken, s.computerdToken]) assert(!JSON.stringify(configs.web).includes(secret));
  const changed = stackWorkerConfigs({ ...s, authSecret: "new-auth-secret" }, environment(s), backend, web);
  assert.notEqual(configs.web.vars.BASKULE_BACKEND_CONFIG_SHA256, changed.web.vars.BASKULE_BACKEND_CONFIG_SHA256);
  assert.equal(configs.backend.vars.AUTH_SECRET, s.authSecret);
  assert.equal(backend.name, "baskule");
  for (const length of [60, 63]) {
    const id = "a".repeat(length - "baskule-dev-".length);
    const named = stackWorkerConfigs({ ...s, id }, environment(s), backend, web);
    assert.equal(named.backend.name, `baskule-dev-${id}`);
    assert.equal(named.web.name, `baskule-web-${id}`);
    assert.equal(named.backend.name.length, length);
    assert.equal(named.web.name.length, length);
    assert.deepEqual(named.web.services, [{ binding: "BACKEND", service: named.backend.name }]);
  }
});

test("celld dev serves the public worker and registers the backend as a service", () => {
  const recipe = celldRecipe({ ...stack, ports: { celld: 12346 }, definition: { mode: "dev" } });
  assert.deepEqual(recipe.args, ["dev", "wrangler.web.json", "--service", "backend/wrangler.json", "--port", "12346", "--no-watch", "--logs"]);
});

test("RustFS deployment publishes the backend by name before adopting the public worker", () => {
  const calls = [];
  const s = { ...stack, bucketPrefix: "test-instance/", definition: { mode: "rustfs", env: {} }, overrides: {}, ports: { celld: 12346, internal: 12347 } };
  const recipe = celldRecipe(s, (_command, args) => calls.push(args));
  assert.equal(calls.length, 2);
  assert(calls[0][1].endsWith("/app/backend/wrangler.json"));
  assert(calls[0].includes("--named-only"));
  assert(calls[1][1].endsWith("/app/wrangler.web.json"));
  assert(!calls[1].includes("--named-only"));
  assert.equal(recipe.env.CELLD_NODE, "baskule-dev-test-instance");
});

test("gc removes old web builds and keeps recent builds", (t) => {
  const root = mkdtempSync(join(tmpdir(), "baskule-dev-build-cache-"));
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
  const root = mkdtempSync(join(tmpdir(), "baskule-dev-bad-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "run/stacks"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "broken.json"), "{");
  const r = spawnSync(process.execPath, ["scripts/stack.mjs", "gc", "--json"], { encoding: "utf8", env: { ...process.env, BASKULE_SHARED: root } });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout).removed, []);
  assert.match(r.stderr, /Keeping unreadable registry/); assert(existsSync(join(dir, "broken.json")));
});

for (const command of [["reload"], ["restart", "celld"]]) test(`${command.join(" ")} refuses a stopped stack without registering or launching`, (t) => {
  const root = mkdtempSync(join(tmpdir(), "baskule-dev-stopped-stack-"));
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

test("full stack uses Docker with a scoped network and accepts image overrides", () => {
  const env = environment(stack);
  assert.equal(env.COMPUTER_BACKEND, "docker");
  assert.equal(env.COMPUTER_NETWORK, `baskule-computers-${stack.id}`);
  assert.equal(environment({ ...stack, overrides: { COMPUTER_GUARD_IMAGE: "test:guard" } }).COMPUTER_GUARD_IMAGE, "test:guard");
  assert.deepEqual(JSON.parse(readFileSync("stack/profiles/full.json")).shared, []);
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


test("computer purge removes scoped networks before guard garbage collection", async () => {
  const calls = [];
  await cleanupComputers({ ...stack, overrides: {}, definition: { services: { computerd: {} } } }, true, (cmd, args) => {
    calls.push(args);
    return args[0] === "network" && args[1] === "ls" ? "network-id" : "";
  });
  const listing = calls.find(args => args[0] === "network" && args[1] === "ls");
  assert(listing.includes("label=baskule.instance=test-instance"));
  const removal = calls.findIndex(args => args[0] === "network" && args[1] === "rm");
  assert.deepEqual(calls[removal], ["network", "rm", "network-id"]);
  assert.equal(calls[removal + 1][0], "run");
  assert(calls[removal + 1].at(-1).includes("guardGcScript()"));
});

for (const uid of [0, 1000]) for (const available of [false, true]) {
  test(`proxy defaults to root with Portless (uid=${uid}, portless=${available})`, () => {
    const notices = [];
    assert.equal(stackProxy({ override: "", uid, checkPortless: () => available, report: (message) => notices.push(message) }), uid === 0 && available);
    assert.equal(notices.length, uid === 0 && available ? 0 : 1);
    if (notices.length) assert.match(notices[0], /direct loopback HTTP/);
  });
  test(`explicit proxy overrides remain authoritative (uid=${uid}, portless=${available})`, () => {
    const options = { uid, checkPortless: () => available, report: () => assert.fail("explicit overrides must not print fallback notices") };
    assert.equal(stackProxy({ ...options, override: "0", checkPortless: () => assert.fail("disabled proxy must not probe Portless") }), false);
    if (uid === 0 && available) assert.equal(stackProxy({ ...options, override: "1" }), true);
    else assert.throws(() => stackProxy({ ...options, override: "1" }), /requires root and a working global portless/);
  });
}

test("every local celld launch normalizes disabled eviction before a binary override", () => {
  const dir = mkdtempSync(join(tmpdir(), "celld-idle-env-"));
  try {
    const binary = join(dir, "celld");
    writeFileSync(binary, '#!/usr/bin/env bash\nprintf "%s:%s\\n" "${CELLD_IDLE_EVICT_S-unset}" "$*"\n', { mode: 0o755 });
    for (const [value, expected] of [["0", "unset"], ["900", "900"]]) {
      const result = spawnSync("scripts/celld.sh", ["dev", "fixture"], {
        encoding: "utf8", env: { ...process.env, CELLD_IDLE_EVICT_S: value, CELLD_BIN: binary },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `${expected}:dev fixture`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
