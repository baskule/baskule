import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const realConfig = { E2E_REAL: "1", REAL_BASE_URL: "http://127.0.0.1:1/v1", E2E_MODEL: "test-model", PRICE_IN: "2", PRICE_OUT: "4", E2E_REAL_API_KEY: "test-key" };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "baskule-llm-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** Runs asynchronously: a fixture server in this process must keep answering the child. */
async function nodeResult(file, args, env) {
  const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const [code] = await once(child, "exit");
  return { code, output };
}
async function runNode(file, args, env) {
  const { code, output } = await nodeResult(file, args, env);
  assert.equal(code, 0, output);
  return output;
}

test("real routing rejects missing or invalid configuration before starting services", () => {
  for (const key of ["REAL_BASE_URL", "E2E_MODEL", "PRICE_IN", "PRICE_OUT"]) {
    const result = spawnSync(process.execPath, [join(root, "e2e/llm/router.mjs")], { encoding: "utf8", env: { ...process.env, ...realConfig, [key]: "" } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Real runs require ${key}`));
  }
  for (const price of ["-1", "NaN", "Infinity"]) {
    const result = spawnSync(process.execPath, [join(root, "e2e/llm/router.mjs")], { encoding: "utf8", env: { ...process.env, ...realConfig, PRICE_IN: price } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nonnegative USD prices/);
  }
});

/** settings.mjs, copied without deploy/.env, against a fake settings API holding `original`. */
async function settingsFixture(t, original) {
  const dir = fixture(t);
  mkdirSync(join(dir, "e2e/llm"), { recursive: true });
  const script = join(dir, "e2e/llm/settings.mjs");
  copyFileSync(join(root, "e2e/llm/settings.mjs"), script);
  const state = { current: original };
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/baskule") return res.end(JSON.stringify({ authentication: { mode: "authenticated" } }));
    if (req.url === "/auth/sign-in/email") {
      let text = ""; for await (const part of req) text += part;
      assert.deepEqual(JSON.parse(text), { email: "admin@baskule.test", password: "test-password" });
      res.setHeader("set-auth-token", "fixture-token"); return res.end("{}");
    }
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    if (req.method === "PATCH") { let text = ""; for await (const part of req) text += part; state.current = JSON.parse(text); }
    res.end(JSON.stringify(state.current));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, E2E_REAL: "0", E2E_BASE_URL: `http://127.0.0.1:${server.address().port}`, E2E_LOGIN_EMAIL: "admin@baskule.test", E2E_LOGIN_PASSWORD: "test-password" };
  return { script, state, env };
}

test("router settings work without deploy/.env and explicitly select fake or configured models", async t => {
  const original = { ai: { providerId: "custom", model: { id: "installation-model" }, baseUrl: "http://installation.test/v1" }, idleMinutes: 10 };
  const { script, state, env } = await settingsFixture(t, original);
  await runNode(script, ["router", "http://router.test/v1", "1.5"], env);
  assert.equal(state.current.ai.model.id, "fake-model");
  assert.equal(state.current.apiKey, "");
  await runNode(script, ["router", "http://router.test/v1", "1.5"], { ...env, ...realConfig });
  assert.equal(state.current.ai.model.id, "test-model");
  assert.equal(state.current.apiKey, "test-key");
  await runNode(script, ["restore"], env);
  assert.deepEqual(state.current, original);
});

test("an installation without an AI provider stays unconfigured: status says so, idle restores it and router refuses", async t => {
  const original = { ai: null, idleMinutes: 10 };
  const { script, state, env } = await settingsFixture(t, original);
  assert.equal((await runNode(script, ["status"], env)).trim(), "unconfigured");
  await runNode(script, ["idle", "1"], env);
  assert.deepEqual(state.current, { ai: null, idleMinutes: 1 });
  const router = await nodeResult(script, ["router", "http://router.test/v1", "1.5"], env);
  assert.notEqual(router.code, 0);
  assert.match(router.output, /has no AI provider/);
  assert.deepEqual(state.current, { ai: null, idleMinutes: 1 });
  await runNode(script, ["restore"], env);
  assert.deepEqual(state.current, original);
});

test("container configuration is forwarded and changing it recreates the router", t => {
  const dir = fixture(t);
  for (const path of ["e2e/llm", "deploy", "platform/dev/fake-llm", "bin"]) mkdirSync(join(dir, path), { recursive: true });
  for (const file of ["llm.sh", "router.mjs"]) copyFileSync(join(root, "e2e/llm", file), join(dir, "e2e/llm", file));
  writeFileSync(join(dir, "e2e/llm/settings.mjs"), "// Settings API is covered separately.\n");
  writeFileSync(join(dir, "deploy/lib.sh"), "log() { :; }\n");
  writeFileSync(join(dir, "platform/dev/fake-llm/server.mjs"), "// fixture\n");
  writeFileSync(join(dir, "bin/docker"), `#!${process.execPath}
const fs = require("node:fs"), p = process.env.FIXTURE, args = process.argv.slice(2);
fs.appendFileSync(p + "/calls", JSON.stringify(args) + "\\n");
if (args[0] === "inspect") process.stdout.write(fs.existsSync(p + "/label") ? fs.readFileSync(p + "/label") : "");
if (args[0] === "run") fs.writeFileSync(p + "/label", args[args.indexOf("--label") + 1].split("=")[1]);
`, { mode: 0o755 });
  function run(extra = {}) {
    const result = spawnSync("bash", [join(dir, "e2e/llm/llm.sh"), "router", "0.5"], { encoding: "utf8", env: { ...process.env, ...realConfig, PATH: `${dir}/bin:${process.env.PATH}`, FIXTURE: dir, ...extra } });
    assert.equal(result.status, 0, result.stderr);
  }
  run(); run(); run({ PRICE_OUT: "5" });
  const runs = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse).filter(args => args[0] === "run");
  assert.equal(runs.length, 2);
  for (const value of ["E2E_REAL=1", "REAL_BASE_URL=http://127.0.0.1:1/v1", "E2E_MODEL=test-model", "PRICE_IN=2", "PRICE_OUT=4"]) assert.ok(runs[0].includes(value), value);
  assert.ok(runs[1].includes("PRICE_OUT=5"));
  assert.ok(runs.every(args => !args.some(arg => arg.includes("test-key"))), "API key belongs to settings, not the router environment");
});
