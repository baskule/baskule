// Unit tests: computerd against a fake gateway (test/fake-backend.ts). Run: pnpm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { FakeBackend } from "./fake-backend.ts";
import { Client, wsExchange } from "./client.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { Backend, MachineSpec } from "../src/backend.ts";
import { Computers } from "../src/computers.ts";
import { createServer } from "../src/server.ts";
import { namesFor } from "../src/policy.ts";
import { filterEnv } from "../src/exec.ts";
import { normalizePath, parseRange, PathError } from "../src/files.ts";

const TOKEN = "unit-test-token-0123456789";
let fake: FakeBackend;
let root: string;
let cdp: WebSocketServer;
let cdpPort: number;
let bridge: http.Server;
let bridgeWs: WebSocketServer;
let cfg: Config;
let backend: Backend;
let computers: Computers;
let server: http.Server;
let c: Client;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "baskule-computerd-unit-"));
  // A fake `baskule-browser` on the computer's PATH ($HOME/.local/bin) and a fake DevTools endpoint.
  cdp = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => cdp.once("listening", r));
  cdpPort = (cdp.address() as any).port;
  cdp.on("connection", (ws, req) => {
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      ws.send(JSON.stringify({ id: m.id, result: { path: req.url, targetInfos: [{ type: "page", targetId: "T1" }] } }));
    });
  });
  const bin = join(root, "space/home/.local/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "baskule-browser"),
    `#!/bin/sh\necho '{"Browser":"Fake","webSocketDebuggerUrl":"ws://127.0.0.1:${cdpPort}/devtools/browser/abc-123"}'\n`,
  );
  chmodSync(join(bin, "baskule-browser"), 0o755);
  writeFileSync(join(bin, "baskule-browser-bridge"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "baskule-browser-bridge"), 0o755);
  bridge = http.createServer(async (req, res) => {
    if (req.url === "/events?headers-only") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
      // No body: the downstream must not wait for a future heartbeat.
      return;
    }
    let body = ""; for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url, body, auth: req.headers.authorization ?? null }));
  });
  bridgeWs = new WebSocketServer({ server: bridge });
  bridgeWs.on("connection", (ws, req) => {
    if (req.url?.includes("startup=1")) {
      ws.send(JSON.stringify({ type: "control", controller: "unclaimed" }));
      ws.send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    if (req.url?.includes("fail=1")) ws.close(1011, "Browser could not start");
    ws.on("message", data => ws.send(JSON.stringify({ path: req.url, data: data.toString() })));
  });
  await new Promise<void>(r => bridge.listen(0, "127.0.0.1", r));
  fake = new FakeBackend();
  fake.environment = { ...process.env, HOME: join(root, "space/home"), PATH: bin + ":" + process.env.PATH };
  cfg = loadConfig({
    COMPUTERD_TOKEN: TOKEN,
    SANDBOX_ROOT: root,
    BASKULE_CDP_PORT: String(cdpPort),
    BASKULE_BROWSER_PORT: String((bridge.address() as any).port),
    MAX_STREAMS_PER_COMPUTER: "3",
    IDLE_MINUTES: "10",
  });
  backend = fake;
  computers = new Computers(backend, cfg);
  server = createServer({ cfg, backend, computers });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  c = new Client(`http://127.0.0.1:${(server.address() as any).port}`, TOKEN);
});

after(() => {
  server.closeAllConnections();
  server.close();
  cdp.close();
  bridgeWs.close(); bridge.closeAllConnections(); bridge.close();
  backend.close();
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------- pure functions
test("namesFor: os-<id> when it fits the 19-char DNS label, else a stable hash", () => {
  assert.deepEqual(namesFor("abc-1"), { sandbox: "os-abc-1", volume: "baskule-space-abc-1" });
  const long = namesFor("Space_With_Upper_And_Long_Id");
  assert.match(long.sandbox, /^os-[0-9a-f]{16}$/);
  assert.equal(long.sandbox.length, 19);
  assert.equal(namesFor("Space_With_Upper_And_Long_Id").sandbox, long.sandbox);
  assert.notEqual(namesFor("x".repeat(17)).sandbox, namesFor("x".repeat(18)).sandbox);
});

test("normalizePath confines to the root and rejects ..", () => {
  assert.equal(normalizePath("/sandbox", "/sandbox//space/./a/"), "/sandbox/space/a");
  assert.equal(normalizePath("/sandbox", "/sandbox"), "/sandbox");
  for (const [p, status] of [
    ["/sandbox/../etc", 400],
    ["/sandbox/space/../x", 400],
    ["relative", 400],
    ["/etc/passwd", 403],
    ["/sandboxx/a", 403],
    ["/sandbox/a\nb", 400],
  ] as const) {
    assert.throws(() => normalizePath("/sandbox", p), (e: any) => e instanceof PathError && e.status === status, p);
  }
});

test("parseRange", () => {
  assert.deepEqual(parseRange("bytes=0-9"), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=5-"), { start: 5 });
  assert.deepEqual(parseRange("bytes=-3"), { suffix: 3 });
  assert.equal(parseRange("bytes=9-1"), "invalid");
  assert.equal(parseRange("items=1-2"), "invalid");
  assert.equal(parseRange("bytes=0-1,4-5"), null);
  assert.equal(parseRange(undefined), null);
});

test("filterEnv keeps the allowlist only", () => {
  const { env, dropped } = filterEnv({
    LANG: "C", LC_ALL: "C", PYTHONPATH: "/x", GIT_AUTHOR_NAME: "a", BASKULE_BROWSER: "isolated",
    UNTRUSTED_MARKER: "0", LD_PRELOAD: "/x.so", AWS_SECRET_ACCESS_KEY: "s", "BAD-KEY": "x", "A;rm": "x", PATH: 3 as any,
  });
  assert.deepEqual(Object.keys(env).sort(), ["BASKULE_BROWSER", "GIT_AUTHOR_NAME", "LANG", "LC_ALL", "PYTHONPATH"]);
  assert.deepEqual(dropped.sort(), ["A;rm", "AWS_SECRET_ACCESS_KEY", "BAD-KEY", "LD_PRELOAD", "PATH", "UNTRUSTED_MARKER"]);
});



// ------------------------------------------------------------------------------------------------ HTTP API
test("auth and health", async () => {
  assert.equal((await fetch(c.base + "/healthz")).status, 200);
  assert.equal((await fetch(c.base + "/v1/spaces/auth-test/computer")).status, 401);
  assert.equal((await fetch(c.base + "/v1/spaces/auth-test/computer", { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await c.req("GET", "/v1/spaces/bad.id/computer")).status, 400);
  assert.equal((await c.req("GET", "/v1/nope")).status, 404);
});


test("ensure: creates os-<id> with disk and resources; idempotent", async () => {
  const r = await c.json("POST", "/v1/spaces/s1/computer/ensure", {});
  assert.equal(r.phase, "ready");
  assert.equal(r.created, true);
  const create = fake.calls.find((x) => x.method === "create")!.req as MachineSpec;
  assert.equal(create.name, "os-s1");
  assert.equal(create.disk, "baskule-space-s1");
  assert.equal(create.image, "baskule-computer:local");
  assert.equal(create.cpus, "2");
  assert.equal(create.memory, "3Gi");
  // first exec prepared home + chats
  assert.ok((await c.exec("s1", { argv: ["test", "-d", `${root}/space/chats`] })).code === 0);
  const again = await c.json("POST", "/v1/spaces/s1/computer/ensure", {});
  assert.equal(again.created, false);
  assert.equal(fake.calls.filter((x) => x.method === "create").length, 1);
});

test("ensure: concurrent calls share one creation", async () => {
  const before = fake.calls.filter((x) => x.method === "create").length;
  await Promise.all([1, 2, 3, 4].map(() => c.json("POST", "/v1/spaces/conc/computer/ensure", {})));
  assert.equal(fake.calls.filter((x) => x.method === "create").length, before + 1);
});



test("stop then status", async () => {
  await c.json("POST", "/v1/spaces/st1/computer/ensure", {});
  const s = await c.json("POST", "/v1/spaces/st1/computer/stop");
  assert.equal(s.phase, "stopped");
  assert.equal((await c.json("GET", "/v1/spaces/st1/computer")).running, false);
  assert.equal((await c.json("GET", "/v1/spaces/never/computer")).phase, "absent");
});

test("exec: NDJSON frames, exit code, env, cwd; starts a stopped computer", async () => {
  mkdirSync(join(root, "space/work"), { recursive: true });
  const r = await c.exec("st1", {
    argv: ["sh", "-c", 'printf out; printf err >&2; echo " $HOME $(pwd) $LANG ${AWS_X:-no}"; exit 4'],
    cwd: `${root}/space/work`,
    env: { LANG: "fr_FR.UTF-8", AWS_X: "leak" },
  });
  assert.equal(r.code, 4);
  assert.equal(r.stdout, `out ${root}/space/home ${root}/space/work fr_FR.UTF-8 no\n`);
  assert.equal(r.stderr, "err");
  assert.match(r.id!, /^[0-9a-f-]{36}$/);
  const raw = await (await c.req("POST", "/v1/spaces/st1/exec", { argv: ["true"] })).text();
  assert.deepEqual(raw.trim().split("\n").map((l) => JSON.parse(l)), [{ t: "x", code: 0 }]);
});

test("exec: validation errors", async () => {
  for (const body of [{}, { argv: [] }, { argv: "ls" }, { argv: ["a\0b"] }, { argv: ["ls"], cwd: "rel" }, { argv: ["ls"], id: "bad id" }, { argv: ["ls"], stdin: 5 }]) {
    assert.equal((await c.req("POST", "/v1/spaces/s1/exec", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await c.req("POST", "/v1/spaces/s1/exec", { argv: ["x".repeat(300 * 1024)] })).status, 413);
});

test("exec: large stdin reaches the process intact", async () => {
  const big = randomBytes(2 * 1024 * 1024 + 3);
  const r = await c.exec("s1", { argv: ["wc", "-c"], stdin: big.toString("base64") });
  assert.equal(r.stdout.trim(), String(big.length));
  // octet-stream variant with metadata in a header
  const meta = Buffer.from(JSON.stringify({ argv: ["wc", "-c"] })).toString("base64url");
  const res = await c.req("POST", "/v1/spaces/s1/exec", big, { "content-type": "application/octet-stream", "x-baskule-exec": meta });
  const out = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((f) => f.t === "o");
  assert.equal(Buffer.from(out.d, "base64").toString().trim(), String(big.length));
});

test("exec: reuses the computer session", async () => {
  const before = fake.execs.length;
  await c.exec("s1", { id: "wraptest", argv: ["true"] });
  assert.equal(fake.execs.length, before);
});

test("kill: TERM then KILL reaches the whole process group", async (t) => {
  const id = `kill${randomBytes(3).toString("hex")}`;
  const p = c.exec("s1", { id, argv: ["sh", "-c", `trap "" TERM; sleep 61 & sleep 62; echo never`] });
  await t.waitFor(async () => {
    const ps = await c.exec("s1", { argv: ["sh", "-c", "pgrep -f '[s]leep 61' && pgrep -f '[s]leep 62'"] });
    assert.equal(ps.code, 0);
  }, { timeout: 5000 });
  assert.equal((await c.req("POST", "/v1/spaces/s1/exec", { id, argv: ["true"] })).status, 409);
  const k = await c.json("POST", "/v1/spaces/s1/kill", { id, graceMs: 300 });
  assert.equal(k.killed, true);
  const r = await p;
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.stdout, /never/);
  await t.waitFor(async () => assert.equal((await c.exec("s1", { argv: ["sh", "-c", "pgrep -f '[s]leep 6[12]' || echo none"] })).stdout.trim(), "none"), { timeout: 5000 });
  const ps = await c.exec("s1", { argv: ["sh", "-c", "pgrep -f '[s]leep 6[12]' || echo none"] });
  assert.equal(ps.stdout.trim(), "none");
  assert.equal((await c.json("POST", "/v1/spaces/s1/kill", { id: "nosuchexec" })).killed, false);
  assert.equal((await c.req("POST", "/v1/spaces/s1/kill", { id, signal: "STOP" })).status, 400);
});

test("exec: timeoutMs kills the process", async () => {
  const t0 = Date.now();
  const r = await c.exec("s1", { argv: ["sleep", "30"], timeoutMs: 300 });
  assert.ok(Date.now() - t0 < 5000);
  assert.notEqual(r.code, 0);
});

test("exec: at most N concurrent streams per computer (429)", async (t) => {
  const ac = new AbortController();
  const hold = [1, 2, 3].map(() =>
    fetch(c.base + "/v1/spaces/s1/exec", {
      method: "POST",
      headers: c.h({ "content-type": "application/json" }),
      body: JSON.stringify({ argv: ["sleep", "5"] }),
      signal: ac.signal,
    }),
  );
  await Promise.all(hold);
  const r = await c.req("POST", "/v1/spaces/s1/exec", { argv: ["true"] });
  assert.equal(r.status, 429);
  assert.equal((await c.req("POST", "/v1/spaces/other/exec", { argv: ["true"] })).status, 200);
  ac.abort();
  await t.waitFor(async () => assert.equal((await c.json("GET", "/v1/spaces/s1/computer")).activeStreams, 0), { timeout: 5000 });
  assert.equal((await c.exec("s1", { argv: ["true"] })).code, 0);
});

test("files: put / get / range / stat / list / confinement", async () => {
  const S = "/v1/spaces/s1/files?path=";
  const p = `${root}/space/f/sub/a.bin`;
  const data = randomBytes(300_000);
  const put = await c.req("PUT", S + p, data);
  assert.equal(put.status, 200);
  assert.equal((await put.json()).size, data.length);
  const get = await c.req("GET", S + p);
  assert.equal(get.headers.get("content-length"), String(data.length));
  assert.ok(Buffer.from(await get.arrayBuffer()).equals(data));
  const rg = await c.req("GET", S + p, undefined, { range: "bytes=100-199" });
  assert.equal(rg.status, 206);
  assert.ok(Buffer.from(await rg.arrayBuffer()).equals(data.subarray(100, 200)));
  const tail = await c.req("GET", S + p, undefined, { range: "bytes=299990-" });
  assert.equal(tail.headers.get("content-range"), `bytes 299990-299999/300000`);
  assert.equal((await c.req("GET", S + p, undefined, { range: "bytes=300000-" })).status, 416);
  const st = await c.json("GET", `${S}${p}&stat=1`);
  assert.deepEqual([st.type, st.size], ["file", data.length]);
  await c.json("PUT", `${S}${root}/space/f/newdir&type=dir`);
  writeFileSync(join(root, "space/f/name with\ttab and spaces.txt"), "x");
  const ls = await c.json("GET", `${S}${root}/space/f`);
  assert.deepEqual(ls.entries.map((e: any) => `${e.type}:${e.name}`), ["dir:newdir", "dir:sub", "file:name with\ttab and spaces.txt"]);
  assert.equal((await c.req("GET", `${S}${root}/space/f/missing`)).status, 404);
  assert.equal((await c.req("GET", `${S}${root}/space/../x`)).status, 400);
  assert.equal((await c.req("GET", `${S}/etc/passwd`)).status, 403);
  assert.equal((await c.req("PUT", `${S}${root}`, Buffer.from("x"))).status, 403);
  await c.exec("s1", { argv: ["ln", "-sfn", "/etc", `${root}/space/f/esc`] });
  assert.equal((await c.req("GET", `${S}${root}/space/f/esc/hostname`)).status, 403);
  assert.equal((await c.req("PUT", `${S}${root}/space/f/esc/x`, Buffer.from("x"))).status, 403);
  assert.equal((await c.req("PUT", `${S}${root}/space/f/sub`, Buffer.from("x"))).status, 409);
});

test("cdp: tunnel reaches the browser endpoint (and ?target=)", async () => {
  const r = await wsExchange(c.ws("/v1/spaces/s1/cdp"), [JSON.stringify({ id: 1, method: "Target.getTargets" })], (m) => m.length > 0);
  const res = JSON.parse(r.msgs[0]);
  assert.equal(res.result.path, "/devtools/browser/abc-123");
  const r2 = await wsExchange(c.ws("/v1/spaces/s1/cdp?target=T1"), [JSON.stringify({ id: 2 })], (m) => m.length > 0);
  assert.equal(JSON.parse(r2.msgs[0]).result.path, "/devtools/page/T1");
  assert.equal((await c.req("GET", "/v1/spaces/s1/cdp?target=../x")).status, 426);
  const noauth = new (await import("ws")).WebSocket(c.base.replace("http", "ws") + "/v1/spaces/s1/cdp");
  await assert.rejects(wsExchange(noauth, [], () => false), /401/);
});

test("idle stop: only after IDLE with no streams and no keep", async () => {
  await c.json("POST", "/v1/spaces/idle1/computer/ensure", {});
  await c.json("POST", "/v1/spaces/idle2/computer/ensure", { keep: true });
  const stops = () => fake.calls.filter((x) => x.method === "stop").map((x) => x.req.name);
  const before = stops().length;
  await computers.idleTick(Date.now() + 5 * 60_000); // not idle long enough
  assert.equal(stops().length, before);
  const release = computers.acquire("idle1"); // a running stream blocks idle stop
  await computers.idleTick(Date.now() + 11 * 60_000);
  assert.ok(!stops().slice(before).includes("os-idle1"));
  release();
  await computers.idleTick(Date.now() + 11 * 60_000);
  assert.ok(stops().slice(before).includes("os-idle1"));
  assert.ok(!stops().slice(before).includes("os-idle2"), "keep pins the computer");
  assert.equal((await c.json("GET", "/v1/spaces/idle1/computer")).phase, "stopped");
});

test("an idle stop first clears download and browser caches, keeping installs, profiles and chats", async () => {
  const home = join(root, "space/home");
  const profile = join(home, ".baskule-browser/userdata/server-browser/profiles/default");
  const seed = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "x"); };
  const cleared = [".cache/pip/wheel", ".cache/uv/archive", ".npm/_cacache/index", ".bun/install/cache/pkg"]
    .map((p) => join(home, p))
    .concat(["Default/Cache/data_0", "Default/Code Cache/js/index", "Default/GPUCache/data_1"].map((p) => join(profile, p)));
  const kept = [".local/lib/python3.13/site-packages/docx/__init__.py", ".local/share/pnpm/store/v10/index"]
    .map((p) => join(home, p))
    .concat([join(profile, "Default/Cookies"), join(root, "space/chats/c1/report.docx")]);
  for (const path of [...cleared, ...kept]) seed(path);
  await c.json("POST", "/v1/spaces/idle3/computer/ensure", {});
  await computers.idleTick(Date.now() + 11 * 60_000);
  assert.equal((await c.json("GET", "/v1/spaces/idle3/computer")).phase, "stopped");
  for (const path of cleared) assert.throws(() => readFileSync(path), /ENOENT/, path);
  for (const path of kept) assert.equal(readFileSync(path, "utf8"), "x", path);
});

test("idle policy follows organization settings and skips stopping when the control plane is unavailable", async () => {
  let minutes = 60, available = true;
  const policy = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    res.writeHead(available ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ idleMinutes: minutes }));
  });
  await new Promise<void>(resolve => policy.listen(0, "127.0.0.1", resolve));
  const previous = { url: cfg.productSettingsUrl, idleMs: cfg.idleMs };
  cfg.productSettingsUrl = `http://127.0.0.1:${(policy.address() as { port: number }).port}/policy`;
  try {
    await c.json("POST", "/v1/spaces/policy1/computer/ensure", {});
    await computers.idleTick(Date.now() + 11 * 60_000);
    assert.equal((await computers.status("policy1")).phase, "ready");
    minutes = 1; available = false;
    await computers.idleTick(Date.now() + 11 * 60_000);
    assert.equal((await computers.status("policy1")).phase, "ready");
    available = true;
    await computers.idleTick(Date.now() + 11 * 60_000);
    assert.equal((await computers.status("policy1")).phase, "stopped");
  } finally {
    cfg.productSettingsUrl = previous.url; cfg.idleMs = previous.idleMs;
    policy.closeAllConnections(); await new Promise<void>(resolve => policy.close(() => resolve()));
  }
});

test("adopt: running managed computers unknown to this process get idle-stopped", async () => {
  const fresh = new Computers(backend, { ...cfg, idleMs: 1000 });
  await fresh.adopt();
  await fresh.idleTick(Date.now() + 2000);
  const ready = [...fake.sandboxes.values()].filter((s) => s.phase === "ready" || s.phase === "stopping");
  assert.ok(ready.every((s) => s.phase !== "ready"), ready.map((s) => `${s.name}:${s.phase}`).join(","));
});

test("delete: needs {confirm: <spaceId>}, removes sandbox and volume, idempotent", async () => {
  await c.json("POST", "/v1/spaces/del1/computer/ensure", {});
  assert.ok(fake.sandboxes.has("os-del1"));
  assert.ok(fake.disks.has("baskule-space-del1"));
  for (const body of [undefined, {}, { confirm: "other" }, { confirm: true }]) {
    assert.equal((await c.req("POST", "/v1/spaces/del1/computer/delete", body)).status, 400, JSON.stringify(body));
  }
  assert.ok(fake.sandboxes.has("os-del1"), "nothing deleted without confirmation");
  const r = await c.json("POST", "/v1/spaces/del1/computer/delete", { confirm: "del1" });
  assert.deepEqual(r, { spaceId: "del1", sandbox: "os-del1", sandboxDeleted: true, volumeDeleted: true });
  assert.ok(!fake.sandboxes.has("os-del1"));
  assert.ok(!fake.disks.has("baskule-space-del1"));
  assert.equal((await c.json("GET", "/v1/spaces/del1/computer")).phase, "absent");
  const again = await c.json("POST", "/v1/spaces/del1/computer/delete", { confirm: "del1" });
  assert.deepEqual([again.sandboxDeleted, again.volumeDeleted], [false, false]);
  // A later ensure starts from scratch.
  assert.equal((await c.json("POST", "/v1/spaces/del1/computer/ensure", {})).created, true);
  assert.equal((await c.json("POST", "/v1/spaces/del1/computer/delete", { confirm: "del1" })).sandboxDeleted, true);
  assert.equal((await fetch(c.base + "/v1/spaces/del1/computer/delete", { method: "POST", body: '{"confirm":"del1"}' })).status, 401);
});

test("delete: long space ids use the hashed names", async () => {
  const id = "Team_Space_With_A_Long_Identifier";
  const n = namesFor(id);
  await c.json("POST", `/v1/spaces/${id}/computer/ensure`, {});
  const r = await c.json("POST", `/v1/spaces/${id}/computer/delete`, { confirm: id });
  assert.equal(r.sandbox, n.sandbox);
  assert.ok(!fake.sandboxes.has(n.sandbox) && !fake.disks.has(n.volume));
});


test("shared browser: authenticated HTTP and viewer tunnels keep credentials off the computer", async () => {
  const result = await c.json("POST", "/v1/spaces/browser1/browser/call", { method: "list", input: { threadId: "t1" } });
  assert.equal(result.path, "/call"); assert.equal(result.auth, null);
  assert.equal(JSON.parse(result.body).method, "list");
  const viewer = await wsExchange(c.ws("/v1/spaces/browser1/browser/ws?threadId=t1&tabId=p1"), ["hello"], messages => messages.length > 0);
  assert.equal(JSON.parse(viewer.msgs[0]).path, "/ws?threadId=t1&tabId=p1");
  assert.equal((await fetch(`${c.base}/v1/spaces/browser1/browser/call`, { method: "POST" })).status, 401);
  assert.equal((await c.req("GET", "/v1/spaces/browser1/browser/call")).status, 405);
  assert.equal((await c.req("GET", "/v1/spaces/browser1/browser/arbitrary")).status, 404);
  const noauth = new (await import("ws")).WebSocket(c.base.replace("http", "ws") + "/v1/spaces/browser1/browser/ws");
  await assert.rejects(wsExchange(noauth, [], () => false), /401/);
});


test("shared browser: delivers initial control and frame without viewer input", async () => {
  const result = await wsExchange(c.ws("/v1/spaces/browser-startup/browser/ws?startup=1"), [], messages => messages.length === 2, 2000);
  assert.deepEqual(JSON.parse(result.msgs[0]), { type: "control", controller: "unclaimed" });
  assert.equal(result.msgs.length, 2);
});

test("shared browser: preserves launch failure codes and reasons", async () => {
  const result = await wsExchange(c.ws("/v1/spaces/browser-fail/browser/ws?fail=1"), [], () => false, 2000);
  assert.deepEqual(result.close, { code: 1011, reason: "Browser could not start" });
});

test("shared browser: metadata never creates or wakes a computer", async () => {
  const id = "browser-metadata";
  const sandbox = namesFor(id).sandbox;
  assert.equal((await c.req("GET", `/v1/spaces/${id}/browser/events`)).status, 503);
  assert.equal(fake.sandboxes.has(sandbox), false);
  await c.json("POST", `/v1/spaces/${id}/computer/ensure`, {});
  const events = await c.json("GET", `/v1/spaces/${id}/browser/events`);
  assert.equal(events.path, "/events");
  await computers.stop(id, "test");
  assert.equal((await c.req("GET", `/v1/spaces/${id}/browser/events`)).status, 503);
  assert.equal((await computers.status(id)).running, false);
  const peek = await c.json("GET", `/v1/spaces/${id}/browser/peek`);
  assert.deepEqual(peek.result.sessions, []);
  assert.equal((await computers.status(id)).running, false);
});


test("shared browser: metadata headers reach the cell before any heartbeat", async () => {
  await computers.ensure("browser-headers");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${c.base}/v1/spaces/browser-headers/browser/events?headers-only`, {
      headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    await response.body?.cancel();
  } finally { clearTimeout(timer); controller.abort(); }
});



test("instance config: optional, valid label values only", () => {
  assert.equal(loadConfig({ COMPUTERD_TOKEN: TOKEN }).instance, "");
  for (const instance of ["", "a", "osdev-u2a", "worktree_1.dev"]) {
    assert.equal(loadConfig({ COMPUTERD_TOKEN: TOKEN, COMPUTERD_INSTANCE: instance }).instance, instance);
  }
  for (const instance of ["x,baskule.managed=false", " a", "-a", "a-", "a=b", "x".repeat(64)]) {
    assert.throws(() => loadConfig({ COMPUTERD_TOKEN: TOKEN, COMPUTERD_INSTANCE: instance }), /COMPUTERD_INSTANCE/);
  }
});

test("instance names: the same space has distinct sandbox and volume names", () => {
  const a = namesFor("sp1", "osdev-a");
  const b = namesFor("sp1", "osdev-b");
  assert.notEqual(a.sandbox, b.sandbox);
  assert.notEqual(a.volume, b.volume);
  const pairs = [["osdev-a", "sp1"], ["x".repeat(63), "S".repeat(64)], ["A_b.c", "sp1"],
    ["a-b", "c"], ["a", "b-c"]];
  const names = pairs.map(([instance, space]) => namesFor(space, instance));
  assert.equal(new Set(names.map(n => n.sandbox)).size, pairs.length);
  assert.equal(new Set(names.map(n => n.volume)).size, pairs.length);
  for (const name of names) {
    assert.match(name.sandbox, /^[a-z0-9]([a-z0-9-]{0,17}[a-z0-9])?$/);
    assert.match(name.volume, /^baskule-space-[a-z0-9-]{1,48}$/);
  }
  assert.deepEqual(namesFor("sp1", ""), namesFor("sp1"));
});

test("instance scoping: two computerds create, adopt and idle only their own sandboxes", async () => {
  const configA = { ...cfg, instance: loadConfig({ COMPUTERD_TOKEN: TOKEN, COMPUTERD_INSTANCE: "osdev-a" }).instance, idleMs: 1000 };
  const configB = { ...configA, instance: "osdev-b" };
  const a = new Computers(backend, configA);
  const b = new Computers(backend, configB);
  const namesA = namesFor("sp1", configA.instance);
  const namesB = namesFor("sp1", configB.instance);
  const foreign = namesFor("foreign", configA.instance);
  const legacy = namesFor("scoped-legacy", configA.instance);
  try {
    const resultA = await a.ensure("sp1");
    const resultB = await b.ensure("sp1");
    assert.notEqual(resultA.sandbox, resultB.sandbox);
    assert.ok(fake.sandboxes.has(resultA.sandbox));
    assert.ok(fake.sandboxes.has(resultB.sandbox));
    assert.notEqual(namesA.volume, namesB.volume);
    assert.ok(fake.disks.has(namesA.volume));
    assert.ok(fake.disks.has(namesB.volume));
    await computers.ensure("scoped-legacy");
    // Same instance label on an unmanaged sandbox must not make it eligible for adoption.
    fake.sandboxes.set("os-unmanaged", { name: "os-unmanaged", labels: { "baskule.instance": "osdev-a" },
      phase: "ready", image: "", error: null });
    const restartedA = new Computers(backend, configA);
    const restartedB = new Computers(backend, configB);
    await restartedA.adopt();
    await restartedB.adopt();
    await restartedA.idleTick(Date.now() + 2000);
    assert.equal((await backend.get(resultA.sandbox))?.phase, "stopped");
    assert.equal((await backend.get(resultB.sandbox))?.phase, "ready");
    assert.equal((await backend.get("os-scoped-legacy"))?.phase, "ready");
    assert.equal((await backend.get("os-unmanaged"))?.phase, "ready");
    await restartedB.idleTick(Date.now() + 2000);
    assert.equal((await backend.get(resultB.sandbox))?.phase, "stopped");
    assert.equal((await backend.get("os-scoped-legacy"))?.phase, "ready");
    for (const [name, instance] of [[resultA.sandbox, "osdev-a"], [resultB.sandbox, "osdev-b"]]) {
      const sandbox = fake.sandboxes.get(name)!;
      assert.deepEqual(sandbox.labels, { "baskule.managed": "true", "baskule.instance": instance });
    }
    assert.deepEqual(fake.sandboxes.get("os-scoped-legacy")!.labels, { "baskule.managed": "true" });
    fake.sandboxes.set(foreign.sandbox, { name: foreign.sandbox, labels: { "baskule.managed": "true", "baskule.instance": "osdev-b" },
      phase: "ready", image: "", error: null });
    fake.sandboxes.set(legacy.sandbox, { name: legacy.sandbox, labels: { "baskule.managed": "true" },
      phase: "ready", image: "", error: null });
    for (const space of ["foreign", "scoped-legacy"]) {
      await assert.rejects(a.ensure(space), /does not belong/);
      await assert.rejects(a.stop(space, "manual"), /does not belong/);
      await assert.rejects(a.delete(space), /does not belong/);
    }
    assert.ok(fake.sandboxes.has(foreign.sandbox));
    assert.ok(fake.sandboxes.has(legacy.sandbox));
    await a.delete("sp1");
    assert.ok(!fake.disks.has(namesA.volume));
    assert.ok(fake.disks.has(namesB.volume), "deleting A must preserve B's volume");
    assert.ok(fake.sandboxes.has(resultB.sandbox), "deleting A must preserve B's sandbox");
  } finally {
    for (const name of [namesA.sandbox, namesB.sandbox, foreign.sandbox, legacy.sandbox, "os-scoped-legacy", "os-unmanaged"]) {
      await backend.remove(name, "");
    }
    fake.disks.delete(namesA.volume);
    fake.disks.delete(namesB.volume);
  }
});


test("backend config defaults to Docker and validates the selection", () => {
  const config = loadConfig({ COMPUTERD_TOKEN: TOKEN });
  assert.equal(config.backend, "docker");
  assert.equal(config.dockerHost, "unix:///var/run/docker.sock");
  assert.equal(config.network, "baskule-computers");
  assert.throws(() => loadConfig({ COMPUTERD_TOKEN: TOKEN, COMPUTER_BACKEND: "other" }), /COMPUTER_BACKEND/);
});

test("ensure recovers backend errors by restarting the machine", async () => {
  await computers.ensure("backend-error");
  await fake.fail(namesFor("backend-error").sandbox);
  const before = fake.calls.length;
  assert.equal((await c.req("POST", "/v1/spaces/backend-error/computer/ensure", {})).status, 200);
  assert.equal((await c.json("GET", "/v1/spaces/backend-error/computer")).error, null);
  assert.equal(fake.calls.length, before + 1);
});

test("image updates replace stopped computers while keeping disks and running machines", async (t) => {
  const f = new FakeBackend();
  t.after(() => f.close());
  const cs = new Computers(f, cfg);
  await cs.ensure("image-update");
  const name = namesFor("image-update", cfg.instance);
  const machine = f.sandboxes.get(name.sandbox)!;
  machine.image = "old-image";
  await cs.ensure("image-update");
  assert.equal(machine.image, "old-image");
  await f.stop(name.sandbox);
  await cs.ensure("image-update");
  assert.equal(f.sandboxes.get(name.sandbox)?.image, cfg.image);
  assert.ok(f.disks.has(name.volume));
  assert.equal(f.calls.filter(c => c.method === "recreate").length, 1);
});

test("error recovery is attempted once", async (t) => {
  const f = new FakeBackend();
  t.after(() => f.close());
  const cs = new Computers(f, cfg);
  await cs.ensure("recover");
  const name = namesFor("recover", cfg.instance).sandbox;
  const machine = f.sandboxes.get(name)!;
  await f.fail(name);
  await cs.ensure("recover");
  assert.equal(machine.phase, "ready");
  await f.fail(name);
  f.start = async () => { machine.phase = "error"; return machine; };
  await assert.rejects(cs.ensure("recover"), /machine failed/);
  assert.equal(f.calls.filter(c => c.method === "stop").length, 2);
});

test("stopped computers refresh rebuilt tags and changed limits", async (t) => {
  for (const change of ["imageId", "cpus", "memory"] as const) {
    const f = new FakeBackend();
    t.after(() => f.close());
    f.imageId = async () => "sha256:new";
    const cs = new Computers(f, cfg);
    await cs.ensure("refresh");
    const name = namesFor("refresh", cfg.instance).sandbox;
    const machine = f.sandboxes.get(name)!;
    machine[change] = change === "imageId" ? "sha256:old" : "999";
    await cs.ensure("refresh");
    assert.equal(f.calls.filter(c => c.method === "recreate").length, 0);
    await f.stop(name);
    await cs.ensure("refresh");
    assert.equal(f.calls.filter(c => c.method === "recreate").length, 1);
  }
});
