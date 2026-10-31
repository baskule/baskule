// Integration test against a real computerd + OpenShell gateway (see test/integration.sh).
// Env: COMPUTERD_URL, COMPUTERD_TOKEN, SPACE (default random), IDLE_EXPECT_S (if computerd runs with a short
// IDLE_MINUTES: wait up to that many seconds for the idle stop), SKIP_BROWSER=1 to skip MCP/CDP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client, wsExchange } from "./client.ts";

const c = new Client(process.env.COMPUTERD_URL ?? "http://127.0.0.1:47502", process.env.COMPUTERD_TOKEN ?? "");
const space = process.env.SPACE ?? `it${randomBytes(4).toString("hex")}`;
const S = `/v1/spaces/${space}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
console.log(`# space ${space}`);

test("auth is required", async () => {
  const r = await fetch(c.base + `${S}/computer`);
  assert.equal(r.status, 401);
  assert.equal((await fetch(c.base + "/healthz")).status, 200);
});

test("ensure creates the computer", async () => {
  const t0 = Date.now();
  const r = await c.json("POST", `${S}/computer/ensure`, {});
  assert.equal(r.phase, "ready");
  console.log(`# ensure: created=${r.created} ${Date.now() - t0} ms`);
  const again = await c.json("POST", `${S}/computer/ensure`, {});
  assert.equal(again.created, false);
});

test("exec: argv, cwd, env allowlist, exit code, toolchain", async () => {
  const r = await c.exec(space, {
    argv: ["sh", "-c", 'uname -a; python3 --version; node --version; bun --version; git --version; echo "H=$HOME P=$(pwd) L=$LANG F=${FOO:-none} O=${OPENSHELL_X:-none}"; id -u; exit 5'],
    cwd: "/sandbox/space",
    env: { LANG: "C.UTF-8", FOO: "dropped", OPENSHELL_X: "dropped" },
  });
  assert.equal(r.code, 5, r.stderr);
  assert.match(r.stdout, /Linux/);
  assert.match(r.stdout, /Python 3\./);
  assert.match(r.stdout, /v24\./);
  assert.match(r.stdout, /H=\/sandbox\/space\/home P=\/sandbox\/space L=C.UTF-8 F=none O=none/);
  assert.match(r.stdout, /\n1000\n/);
});

test("exec: large stdin (JSON base64 and octet-stream)", async () => {
  const big = randomBytes(3 * 1024 * 1024 + 7);
  const r = await c.exec(space, { argv: ["sh", "-c", "wc -c"], stdin: big.toString("base64") });
  assert.equal(r.stdout.trim(), String(big.length));
  const meta = Buffer.from(JSON.stringify({ argv: ["sha256sum"] })).toString("base64url");
  const res = await c.req("POST", `${S}/exec`, big, { "content-type": "application/octet-stream", "x-baskule-exec": meta });
  const text = await res.text();
  const out = text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((f) => f.t === "o").map((f) => Buffer.from(f.d, "base64").toString()).join("");
  const { createHash } = await import("node:crypto");
  assert.equal(out.split(" ")[0], createHash("sha256").update(big).digest("hex"));
});

test("exec: kill by id kills the whole process group, TERM then KILL", async (t) => {
  const id = `k${randomBytes(4).toString("hex")}`;
  const p = c.exec(space, { id, argv: ["sh", "-c", 'trap "" TERM; sleep 300 & sleep 301'] });
  await t.waitFor(async () => assert.equal((await c.exec(space, { argv: ["sh", "-c", "pgrep -f '[s]leep 300' && pgrep -f '[s]leep 301'"] })).code, 0), { timeout: 10_000 });
  const k = await c.json("POST", `${S}/kill`, { id, graceMs: 1000 });
  assert.equal(k.killed, true);
  const r = await p;
  assert.notEqual(r.code, 0);
  await t.waitFor(async () => assert.equal((await c.exec(space, { argv: ["sh", "-c", "pgrep -f '[s]leep 30[01]' || echo none"] })).stdout.trim(), "none"), { timeout: 10_000 });
  const ps = await c.exec(space, { argv: ["sh", "-c", "pgrep -f 'sleep 30[01]' || echo none"] });
  assert.equal(ps.stdout.trim(), "none");
});

test("exec: client disconnect kills the process", async (t) => {
  const id = `d${randomBytes(4).toString("hex")}`;
  const ac = new AbortController();
  const r = await fetch(c.base + `${S}/exec`, {
    method: "POST",
    headers: c.h({ "content-type": "application/json" }),
    body: JSON.stringify({ id, argv: ["sleep", "333"] }),
    signal: ac.signal,
  });
  assert.equal(r.headers.get("x-exec-id"), id);
  await t.waitFor(async () => assert.equal((await c.exec(space, { argv: ["sh", "-c", "pgrep -f '[s]leep 333'"] })).code, 0), { timeout: 10_000 });
  ac.abort();
  await t.waitFor(async () => assert.equal((await c.exec(space, { argv: ["sh", "-c", "pgrep -f '[s]leep 333' || echo none"] })).stdout.trim(), "none"), { timeout: 10_000 });
  const ps = await c.exec(space, { argv: ["sh", "-c", "pgrep -f '[s]leep 333' || echo none"] });
  assert.equal(ps.stdout.trim(), "none");
});

test("files: put, get, range, stat, list, confinement", async () => {
  const data = randomBytes(2 * 1024 * 1024 + 11);
  const put = await c.req("PUT", `${S}/files?path=/sandbox/space/it/sub/data.bin`, data, { "content-type": "application/octet-stream" });
  assert.equal(put.status, 200, await put.clone().text());
  assert.equal((await put.json()).size, data.length);
  const get = await c.req("GET", `${S}/files?path=/sandbox/space/it/sub/data.bin`);
  assert.equal(get.status, 200);
  assert.ok(Buffer.from(await get.arrayBuffer()).equals(data));
  const rg = await c.req("GET", `${S}/files?path=/sandbox/space/it/sub/data.bin`, undefined, { range: "bytes=10-19" });
  assert.equal(rg.status, 206);
  assert.equal(rg.headers.get("content-range"), `bytes 10-19/${data.length}`);
  assert.ok(Buffer.from(await rg.arrayBuffer()).equals(data.subarray(10, 20)));
  const sf = await c.req("GET", `${S}/files?path=/sandbox/space/it/sub/data.bin`, undefined, { range: "bytes=-5" });
  assert.ok(Buffer.from(await sf.arrayBuffer()).equals(data.subarray(data.length - 5)));
  const bad = await c.req("GET", `${S}/files?path=/sandbox/space/it/sub/data.bin`, undefined, { range: `bytes=${data.length}-` });
  assert.equal(bad.status, 416);
  const st = await c.json("GET", `${S}/files?path=/sandbox/space/it/sub/data.bin&stat=1`);
  assert.equal(st.type, "file");
  assert.equal(st.size, data.length);
  await c.json("PUT", `${S}/files?path=/sandbox/space/it/emptydir&type=dir`);
  const ls = await c.json("GET", `${S}/files?path=/sandbox/space/it`);
  assert.equal(ls.type, "dir");
  assert.deepEqual(ls.entries.map((e: any) => `${e.type}:${e.name}`), ["dir:emptydir", "dir:sub"]);
  const empty = await c.req("PUT", `${S}/files?path=/sandbox/space/it/empty.txt`, Buffer.alloc(0));
  assert.equal(empty.status, 200);
  assert.equal((await c.req("GET", `${S}/files?path=/sandbox/space/it/empty.txt`)).status, 200);
  assert.equal((await c.req("GET", `${S}/files?path=/sandbox/space/it/missing`)).status, 404);
  assert.equal((await c.req("GET", `${S}/files?path=/sandbox/space/../../etc/passwd`)).status, 400);
  assert.equal((await c.req("GET", `${S}/files?path=/etc/passwd`)).status, 403);
  await c.exec(space, { argv: ["ln", "-sfn", "/etc", "/sandbox/space/it/escape"] });
  assert.equal((await c.req("GET", `${S}/files?path=/sandbox/space/it/escape/passwd`)).status, 403);
  assert.equal((await c.req("PUT", `${S}/files?path=/sandbox/space/it/escape/x`, Buffer.from("x"))).status, 403);
});

test("cdp: tunnel to the computer's Chromium lists a page", { skip: process.env.SKIP_BROWSER === "1" }, async () => {
  const ws = c.ws(`${S}/cdp`);
  const r = await wsExchange(ws, [JSON.stringify({ id: 1, method: "Target.getTargets" })], (m) => m.some((x) => x.includes('"id":1')), 60_000);
  const res = JSON.parse(r.msgs.find((x) => x.includes('"id":1'))!);
  const pages = res.result.targetInfos.filter((t: any) => t.type === "page");
  assert.ok(pages.length >= 1, JSON.stringify(res));
  const list = await c.json("GET", `${S}/cdp/json/list`);
  assert.ok(Array.isArray(list) && list.some((t: any) => t.type === "page"));
  // A page-level session through ?target=
  const pws = c.ws(`${S}/cdp?target=${pages[0].targetId}`);
  const pr = await wsExchange(pws, [JSON.stringify({ id: 7, method: "Runtime.evaluate", params: { expression: "1+41" } })], (m) => m.some((x) => x.includes('"id":7')));
  assert.equal(JSON.parse(pr.msgs.find((x) => x.includes('"id":7'))!).result.result.value, 42);
});

test("persistence across stop/start; status", async () => {
  await c.exec(space, { argv: ["sh", "-c", "echo keep-me > /sandbox/space/home/persist.txt"] });
  const t0 = Date.now();
  const st = await c.json("POST", `${S}/computer/stop`);
  assert.equal(st.phase, "stopped");
  console.log(`# stop: ${Date.now() - t0} ms`);
  const t1 = Date.now();
  const r = await c.exec(space, { argv: ["cat", "/sandbox/space/home/persist.txt"] }); // exec starts it lazily
  console.log(`# exec on a stopped computer (start + exec): ${Date.now() - t1} ms`);
  assert.equal(r.stdout.trim(), "keep-me");
  const status = await c.json("GET", `${S}/computer`);
  assert.equal(status.running, true);
});

test("idle stop", { skip: !process.env.IDLE_EXPECT_S }, async () => {
  const limit = Number(process.env.IDLE_EXPECT_S) * 1000;
  const t0 = Date.now();
  for (;;) {
    const s = await c.json("GET", `${S}/computer`);
    if (s.phase === "stopped") break;
    assert.ok(Date.now() - t0 < limit, `still ${s.phase} after ${limit} ms`);
    await sleep(2000); // no-fixed-sleep-allow: Poll computer phase until the idle-stop deadline.
  }
  console.log(`# idle-stopped after ${Date.now() - t0} ms of waiting`);
});

test("delete: sandbox and volume removed (confirmation required), idempotent", async () => {
  assert.equal((await c.req("POST", `${S}/computer/delete`, { confirm: "not-this-space" })).status, 400);
  await c.exec(space, { argv: ["sh", "-c", "echo gone-soon > /sandbox/space/home/del.txt"] }); // running computer
  const t0 = Date.now();
  const r = await c.json("POST", `${S}/computer/delete`, { confirm: space });
  console.log(`# delete: ${Date.now() - t0} ms`);
  assert.equal(r.sandboxDeleted, true);
  assert.equal(r.volumeDeleted, true);
  assert.equal((await c.json("GET", `${S}/computer`)).phase, "absent");
  // Recreated from scratch: the old volume content is gone.
  const e = await c.json("POST", `${S}/computer/ensure`, {});
  assert.equal(e.created, true);
  const ls = await c.exec(space, { argv: ["sh", "-c", "ls /sandbox/space/home/del.txt /sandbox/space/home/persist.txt 2>&1 | grep -c 'No such'"] });
  assert.equal(ls.stdout.trim(), "2");
  assert.equal((await c.json("POST", `${S}/computer/delete`, { confirm: space })).sandboxDeleted, true);
  const again = await c.json("POST", `${S}/computer/delete`, { confirm: space });
  assert.deepEqual([again.sandboxDeleted, again.volumeDeleted], [false, false]);
});
