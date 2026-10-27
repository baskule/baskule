#!/usr/bin/env node
// SpaceCell cell-level test runner (WP-B feedback loop). One command:
//   node src/space/test/run.mjs [--sync] [--keep] [--only a,b] [--skip-schedule]
// It starts the fake LLM (WP-C's, :47551), a fake computerd (:47552) and `celld dev` on the test
// harness (:47550, clean state), then drives spaces the way the Worker and the web client do.
// --sync rebuilds the T3 bundle first (sync-bundle.sh; T3_APP_DIR selects the fork checkout).
// Everything it started is stopped at the end, unless --keep.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, identityHeader, waitFor } from "./rpc-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM = resolve(HERE, "../../..");
const ROOT = resolve(PLATFORM, "..");
const RUN = join(HERE, ".run");
const PORT = 47550;
const LLM_PORT = 47551;
const COMPUTERD_PORT = 47552;
const BASE = `http://127.0.0.1:${PORT}`;
const CELLD = process.env.CELLD_BIN ?? join(ROOT, "scripts/celld.sh");
const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;

const alice = { userId: "u-alice", name: "Alice", email: "alice@example.test", role: "member", sessionId: "ba-alice-1", spaceRole: "owner" };
const bob = { userId: "u-bob", name: "Bob", email: "bob@example.test", role: "member", sessionId: "ba-bob-1", spaceRole: "member" };
const MODEL = { instanceId: "opencode", model: "mistral/fake-model" };

const procs = {};
const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function start(name, cmd, argv, opts = {}) {
  const out = openSync(join(RUN, `${name}.log`), "a");
  const child = spawn(cmd, argv, { stdio: ["ignore", out, out], detached: true, ...opts });
  procs[name] = child;
  return child;
}
async function stop(name) {
  const child = procs[name];
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Promise.race([exited, sleep(45_000)]);
  if (child.exitCode === null) try { process.kill(-child.pid, "SIGKILL"); } catch {}
  delete procs[name];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startCelld({ clean }) {
  const env = {
    ...process.env,
    CELLD_ESBUILD: process.env.CELLD_ESBUILD ?? join(PLATFORM, "node_modules/.bin/esbuild"),
    CELLD_OTEL: "0",
    DO_NOT_TRACK: "1",
    CELLD_V8_HEAP_LIMIT_MB: "1024",
    CELLD_FETCH_TIMEOUT_S: "3600",
  };
  start("celld", CELLD, ["dev", ".", "--port", String(PORT), "--no-watch", "--logs", ...(clean ? ["--clean"] : [])], { cwd: join(RUN, "app"), env });
  await waitFor("celld ready", async () => (await fetch(`${BASE}/`).then((r) => r.ok, () => false)), 120_000, 500);
}

async function check(name, fn) {
  if (only && !only.has(name)) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    log(`PASS ${name} (${Date.now() - t0} ms)${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    appendFileSync(join(RUN, "failures.ndjson"), JSON.stringify({ name, error: String(e?.stack ?? e) }) + "\n");
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e?.stack ?? e) });
    log(`FAIL ${name}: ${String(e?.stack ?? e).slice(0, 1500)}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const http = (path, init = {}) => fetch(`${BASE}${path}`, init);
const as = (identity) => ({ "x-baskule-identity": identityHeader(identity) });
const failureText = (exit) => JSON.stringify(exit);

/** Shell state from a subscribeShell stream: threads by id, kept current. */
function watchShell(client) {
  const shell = { threads: new Map(), events: 0, ready: false };
  // Frames: {kind: "snapshot", snapshot: {threads}} then {kind: "thread.updated", location, thread}, …
  client.stream("orchestration.subscribeShell", {}, (v) => {
    shell.events++;
    if (v.kind === "snapshot") {
      for (const t of v.snapshot?.threads ?? []) shell.threads.set(t.id, t);
      shell.ready = true;
    }
    else if (v.thread?.id) {
      if (v.location === "active") shell.threads.set(v.thread.id, v.thread);
      else shell.threads.delete(v.thread.id);
    } else if (v.kind?.startsWith?.("thread") && v.threadId) shell.threads.delete(v.threadId);
  });
  return shell;
}

/** Thread state from subscribeThread: assistant text updates, messages, run status. */
function watchThread(client, threadId) {
  const state = { messages: new Map(), assistantUpdates: 0, runs: new Map(), events: [], frames: [] };
  const apply = (projection) => {
    for (const m of projection?.messages ?? []) state.messages.set(m.id, m);
    for (const r of projection?.runs ?? []) state.runs.set(r.id, r);
  };
  const stop = client.stream("orchestration.subscribeThread", { threadId }, (v) => {
    state.frames.push(v);
    if (v.projection) apply(v.projection);
    if (v.snapshot) apply(v.snapshot.projection ?? v.snapshot);
    const e = v.event;
    if (!e) return;
    state.events.push(e.type);
    if (e.type === "message.updated") {
      state.messages.set(e.payload.id, e.payload);
      if (e.payload.role === "assistant") state.assistantUpdates++;
    }
    if (e.type === "run.updated" || e.type === "run.created") state.runs.set(e.payload.id, e.payload);
  });
  state.stop = stop;
  state.assistantText = () => [...state.messages.values()].filter((m) => m.role === "assistant").map((m) => m.text).join("");
  state.userMessages = () => [...state.messages.values()].filter((m) => m.role === "user");
  state.settled = () => state.runs.size > 0 && [...state.runs.values()].every((r) => ["completed", "failed", "cancelled", "interrupted"].includes(r.status));
  return state;
}

async function launch(client, projectId, text, title = "Test chat", modelSelection = MODEL) {
  const launched = await client.ok("orchestration.launchThread", {
    commandId: crypto.randomUUID(),
    projectId,
    title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text, attachments: [], author: { id: "forged", name: "Mallory" } },
  });
  return launched.threadId;
}

const dispatch = (client, command) => client.ok("orchestration.dispatchCommand", { commandId: crypto.randomUUID(), ...command });

async function main() {
  mkdirSync(RUN, { recursive: true });
  if (args.includes("--sync")) {
    const r = spawnSync(join(HERE, "../sync-bundle.sh"), [], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("sync-bundle failed");
  }
  if (!existsSync(join(HERE, "../t3/space-cell.js"))) throw new Error("SpaceCell is not prepared. Run scripts/worktree runtime from the repository root (or pass --sync).");
  rmSync(join(RUN, "computers"), { recursive: true, force: true });
  for (const f of ["celld", "fake-llm", "computerd"]) rmSync(join(RUN, `${f}.log`), { force: true });
  const built = spawnSync(join(HERE, "devstack.sh"), ["build"], { stdio: "inherit" });
  if (built.status !== 0) throw new Error("space harness build failed");
  start("fake-llm", process.execPath, [join(PLATFORM, "dev/fake-llm/server.mjs"), "--port", String(LLM_PORT)]);
  start("computerd", process.execPath, [join(HERE, "fake-computerd.mjs"), "--port", String(COMPUTERD_PORT), "--root", join(RUN, "computers")]);
  await startCelld({ clean: true });
  log("stack up");

  let alicePrimary;
  let projectId;
  let firstThreadId;
  async function seedPrimary() {
    if (firstThreadId) return;
    alicePrimary = await RpcClient.open(BASE, "sp1", alice);
    projectId = (await alicePrimary.ok("projects.ensureScratch", {})).projectId;
    firstThreadId = await launch(alicePrimary, projectId, "Remember PELICAN-42 [[fake:text word fixture]]", "Fixture chat");
    const thread = watchThread(alicePrimary, firstThreadId);
    await waitFor("fixture chat ready", () => thread.settled(), 60_000);
    await dispatch(alicePrimary, { type: "thread.metadata.update", threadId: firstThreadId, title: "Renamed pelican" });
    await waitFor("fixture rename ready", async () => {
      const projection = await alicePrimary.ok("orchestration.getThreadProjection", { threadId: firstThreadId });
      return (projection.thread ?? projection.projection?.thread)?.title === "Renamed pelican";
    }, 10_000);
    thread.stop();
  }

  await check("identity-required", async () => {
    const none = await (await http("/s/sp1/api/auth/session")).json();
    assert(none.authenticated === false, `no identity → ${JSON.stringify(none)}`);
    const forged = await (await http("/s/sp1/api/auth/session", { headers: { "x-baskule-identity": "e30" } })).json();
    assert(forged.authenticated === false, "a malformed identity must not authenticate");
    const ok = await (await http("/s/sp1/api/auth/session", { headers: as(alice) })).json();
    assert(ok.authenticated === true, "a forwarded identity authenticates");
    await RpcClient.open(BASE, "sp1", null).then(
      (c) => { c.close(); throw new Error("WebSocket without identity was accepted"); },
      () => undefined,
    );
    await RpcClient.open(BASE, "sp1", "not-base64-json!").then(
      (c) => { c.close(); throw new Error("WebSocket with a forged identity was accepted"); },
      () => undefined,
    );
    const ticketRes = await http("/s/sp1/api/auth/websocket-ticket", { method: "POST", headers: as(alice) });
    const { ticket } = await ticketRes.json();
    await RpcClient.open(BASE, "sp1", bob, `&wsTicket=${encodeURIComponent(ticket)}`).then(
      (c) => { c.close(); throw new Error("Alice's ticket worked with Bob's identity"); },
      () => undefined,
    );
    const withTicket = await RpcClient.open(BASE, "sp1", alice, `&wsTicket=${encodeURIComponent(ticket)}`);
    withTicket.close();
    return "missing/forged identity refused; tickets bound to their identity";
  });

  await check("route-allowlist", async () => {
    for (const [method, path] of [["POST", "/oauth/token"], ["POST", "/api/auth/browser-session"], ["GET", "/api/auth/pairing-links"], ["GET", "/api/connect/link-state"], ["GET", "/"], ["GET", "/api/pull-requests/diff"]]) {
      const r = await http(`/s/sp1${path}`, { method, headers: as(alice) });
      const body = await r.text();
      assert(r.status === 404 && body.includes("unsupported in Baskule"), `${method} ${path} → ${r.status} ${body.slice(0, 120)}`);
    }
    const env = await http("/s/sp1/.well-known/t3/environment", { headers: as(alice) });
    assert(env.ok, `descriptor ${env.status}`);
    return "pairing/oauth/connect/static refused; descriptor served";
  });

  await check("usage-and-limits", async () => {
    const author = { ...alice, userId: "u-usage-alice", sessionId: "usage-alice" };
    const other = { ...bob, userId: "u-usage-bob", sessionId: "usage-bob" };
    const c = await RpcClient.open(BASE, "spusage", author);
    const b = await RpcClient.open(BASE, "spusage", other);
    const ownUsage = async () => (await http(`/_test/usage?userId=${author.userId}`)).json();
    const limits = (settings) => http("/_test/usage/limits", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
    let thread;
    try {
      const pid = (await c.ok("projects.ensureScratch", {})).projectId;
      const tid = await launch(c, pid, "First billed answer [[fake:text recorded]]", "Usage");
      thread = watchThread(c, tid);
      await waitFor("first turn completed", () => thread.settled(), 60_000);
      assert(thread.assistantText().includes("recorded"), `first answer failed: ${JSON.stringify(thread.frames).slice(-6000)}`);
      await waitFor("usage arrives in ControlCell", async () => (await ownUsage()).daily.at(-1).turns > 0, 20_000);
      const before = await ownUsage();
      assert(before.totals.today.tokens > 0, `a usage record needs model-reported tokens: ${JSON.stringify(before.daily.at(-1))}`);
      assert(before.daily.at(-1).turns === 1, `one turn: ${JSON.stringify(before.daily.at(-1))}`);
      const saved = await limits({ enabled: true, rules: [{ window: "daily", tokens: before.totals.today.tokens }] });
      assert(saved.ok, `limit save ${saved.status}`);
      await dispatch(c, { type: "message.dispatch", createdBy: "user", creationSource: "web", threadId: tid, messageId: `message:usage:${crypto.randomUUID()}`, text: "This must be refused", attachments: [], dispatchMode: { type: "queue_after_active" } });
      await waitFor("next turn refused", () => [...thread.runs.values()].some(r => r.status === "failed"), 30_000);
      await waitFor("readable typed usage error", () => JSON.stringify(thread.frames).includes("usage_limit_reached"), 10_000);
      const errors = JSON.stringify(thread.frames);
      assert(errors.includes("usageWindowStatus") && errors.includes("resetsAt") && errors.includes("usage limit has been reached"), `limit error lost its details: ${errors.slice(-2500)}`);
      assert((await ownUsage()).totals.today.tokens === before.totals.today.tokens, "refused turn consumed tokens");
      const otherTid = await launch(b, pid, "Bob is under his own limit [[fake:text allowed]]", "Other author");
      const otherThread = watchThread(b, otherTid);
      try { await waitFor("other author answer", () => otherThread.assistantText().includes("allowed"), 60_000); }
      finally { otherThread.stop(); }
      return "completed turn recorded once for its author; next turn refused with typed readable error; another member can run";
    } finally {
      await limits({ enabled: false, rules: [] });
      thread?.stop(); c.close(); b.close();
    }
  });

  await check("rpc-allowlist", async () => {
    await seedPrimary();
    const c = alicePrimary;
    const terminal = await c.call("terminal.open", { threadId: firstThreadId, terminalId: "t1", cwd: "/sandbox", cols: 80, rows: 24 });
    assert(terminal._tag === "Failure" && failureText(terminal).includes("unsupported in Baskule"), `terminal.open → ${failureText(terminal).slice(0, 300)}`);
    const settings = await c.call("server.updateSettings", { patch: {} });
    assert(settings._tag === "Failure" && failureText(settings).includes("unsupported in Baskule"), "server.updateSettings must be refused (installation-managed)");
    const settle = await c.call("orchestration.dispatchCommand", { type: "thread.settle", commandId: crypto.randomUUID(), threadId: firstThreadId });
    assert(settle._tag === "Failure" && failureText(settle).includes("unsupported in Baskule"), `thread.settle → ${failureText(settle).slice(0, 300)}`);
    const config = JSON.stringify(await c.ok("server.getConfig", {}));
    assert(config.includes('"threadSettlement":false') && config.includes('"threadPinReorder":true'), `capabilities: settlement must be off, pin reorder on`);
    const settingsRead = await c.ok("server.getSettings", {});
    const instance = settingsRead.providerInstances?.opencode ?? settingsRead.settings?.providerInstances?.opencode;
    assert(JSON.stringify(settingsRead).includes("http://agent/sp1/oc"), `managed OpenCode instance missing: ${JSON.stringify(instance ?? settingsRead).slice(0, 300)}`);
    return "terminal, settings writes and settle refused; settlement advertised off";
  });

  await check("files-and-attachments", async () => {
    await seedPrimary();
    const c = alicePrimary;
    const computerCalls = async () => (await (await fetch(`http://127.0.0.1:${COMPUTERD_PORT}/_fake/calls`)).json()).filter((l) => l.includes(" sp1 ") && !/^GET sp1 computer\s*$/.test(l));
    // Status probes (GET /computer) never start a computer. Chatting never woke the computer: the chat folder exists only as a DO record so far.
    assert((await computerCalls()).length === 0, `computerd was called while chatting: ${JSON.stringify(await computerCalls()).slice(0, 300)}`);
    const projection = await c.ok("orchestration.getThreadProjection", { threadId: firstThreadId });
    const cwd = projection.thread?.worktreePath ?? projection.projection?.thread?.worktreePath;
    assert(cwd?.startsWith("/sandbox/space/chats/"), `chat folder ${cwd}`);
    // Files in the chat folder go to the computer.
    await c.ok("projects.writeFile", { cwd, relativePath: "report.csv", contents: "a,b\n1,2\n" });
    const host = join(RUN, "computers/sp1", cwd.slice("/sandbox".length), "report.csv");
    assert(existsSync(host), `report.csv not on the computer (${host})`);
    const listed = await c.ok("projects.listEntries", { cwd, directoryPath: "" });
    assert(JSON.stringify(listed).includes("report.csv"), `listEntries: ${JSON.stringify(listed).slice(0, 300)}`);
    const read = await c.ok("projects.readFile", { cwd, relativePath: "report.csv" });
    assert(read.contents === "a,b\n1,2\n", `readFile: ${JSON.stringify(read).slice(0, 200)}`);
    // T3's home is not reachable through file RPCs (secrets live there).
    const secret = await c.call("projects.readFile", { cwd, relativePath: "/baskule/spaces/sp1/userdata/settings.json" });
    assert(secret._tag === "Failure", "an absolute path into T3's home was readable");
    const outside = await c.call("projects.readFile", { cwd, relativePath: "../../../../etc/passwd" });
    assert(outside._tag === "Failure", "a path outside the workspace was readable");
    // Download through a signed asset URL.
    const url = await c.ok("assets.createUrl", { resource: { _tag: "workspace-file", threadId: firstThreadId, path: "report.csv", disposition: "attachment" } });
    const download = await http(`/s/sp1${url.relativeUrl}`, { headers: as(alice) });
    const body = await download.text();
    assert(download.ok && body === "a,b\n1,2\n", `download ${download.status} ${body.slice(0, 200)}`);
    // Attachments: signed upload, then a message carrying it; bytes stay in DO SQLite.
    const bytes = new TextEncoder().encode("attached notes");
    const upload = await c.ok("attachments.createUploadUrl", { type: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: bytes.length });
    const put = await http(`/s/sp1${upload.relativeUrl}`, { method: "POST", headers: { ...as(alice), "content-type": "text/plain" }, body: bytes });
    assert(put.ok, `upload ${put.status} ${await put.text()}`);
    const thread = watchThread(c, firstThreadId);
    await dispatch(c, { type: "message.dispatch", createdBy: "user", creationSource: "web", threadId: firstThreadId, messageId: `message:attach:${crypto.randomUUID()}`, text: "see attached [[fake:text got it]]", attachments: [{ type: "file", id: upload.attachmentId, name: "notes.txt", mimeType: "text/plain", sizeBytes: bytes.length }], dispatchMode: { type: "queue_after_active" } });
    const sent = await waitFor("message with attachment", () => thread.userMessages().find((m) => m.attachments?.length), 30_000);
    const claimed = sent.attachments[0];
    const asset = await c.ok("assets.createUrl", { resource: { _tag: "attachment", attachmentId: claimed.id } });
    const got = await http(`/s/sp1${asset.relativeUrl}`, { headers: as(alice) });
    assert(got.ok && (await got.text()) === "attached notes", `attachment download ${got.status}`);
    await waitFor("turn settled", () => thread.settled(), 60_000);
    thread.stop();
    return `computer untouched while chatting; write/list/read/download via computerd; attachment ${claimed.id} round-trip`;
  });

  await check("revoke-closes-sockets", async () => {
    await seedPrimary();
    const bobSocket = await RpcClient.open(BASE, "sp1", bob);
    const bobShell = watchShell(bobSocket);
    await waitFor("Bob shell snapshot", () => bobShell.ready, 10_000);
    const status1 = await (await http("/control/sp1/_baskule/status")).json();
    assert(status1.awake === true && status1.sockets >= 2, `status ${JSON.stringify(status1)}`);
    const r = await (await http("/control/sp1/_baskule/revoke", { method: "POST", body: JSON.stringify({ userId: bob.userId }) })).json();
    const closed = await Promise.race([bobSocket.closed, sleep(5000).then(() => null)]);
    assert(closed && closed.code === 4401, `Bob's socket not closed with 4401: ${JSON.stringify(closed)} (${JSON.stringify(r)})`);
    // Alice is untouched.
    await alicePrimary.ok("server.getSettings", {});
    // The 60 s recheck closes a socket whose session ControlCell no longer vouches for.
    const bob2 = { ...bob, sessionId: "ba-bob-2" };
    const again = await RpcClient.open(BASE, "sp1", bob2);
    await (await http("/_test/revoked", { method: "POST", body: JSON.stringify([bob2.sessionId]) })).json();
    const rc = await (await http("/control/sp1/_baskule/recheck", { method: "POST" })).json();
    const closed2 = await Promise.race([again.closed, sleep(5000).then(() => null)]);
    assert(closed2?.code === 4401 && rc.closed === 1, `recheck did not close Bob's socket: ${JSON.stringify(rc)} ${JSON.stringify(closed2)}`);
    await alicePrimary.ok("server.getSettings", {});
    return `push revoke closed=${r.closed} revoked=${r.revoked}; recheck checked=${rc.checked} closed=${rc.closed}`;
  });

  let webhookTask;
  await check("webhook", async () => {
    await seedPrimary();
    const c = alicePrimary;
    const upsert = await c.ok("scheduledTasks.upsert", {
      title: "Hook task", prompt: "Webhook said {{body.msg}} [[fake:text hook done]]", enabled: true,
      schedule: { type: "webhook" }, projectId, workspaceStrategy: { type: "root" }, modelSelection: MODEL,
      runtimeMode: "full-access", interactionMode: "default",
    });
    webhookTask = upsert.task ?? upsert;
    const path = webhookTask.webhook?.path;
    assert(webhookTask.webhook?.url?.startsWith(`${BASE}/hooks/sp1/`), `webhook url ${webhookTask.webhook?.url}`);
    assert(path?.startsWith("/api/hooks/"), `webhook path ${JSON.stringify(webhookTask.webhook)}`);
    const publicPath = `/hooks/sp1/${path.slice("/api/hooks/".length)}`;
    const res = await http(publicPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msg: "hello-hook" }) });
    assert(res.status >= 200 && res.status < 300, `webhook POST ${res.status} ${await res.text()}`);
    const bad = await http(`/hooks/sp1/${webhookTask.id}/wrong-token`, { method: "POST", body: "{}" });
    assert(bad.status >= 400, `a wrong token must fail, got ${bad.status}`);
    const deliveries = await waitFor("delivery recorded", async () => {
      const d = await c.ok("scheduledTasks.listWebhookDeliveries", { id: webhookTask.id });
      return d.deliveries.length > 0 ? d.deliveries : null;
    }, 20_000);
    return `public URL shape <origin>${publicPath.replace(/\/[^/]+$/, "/<token>")} → ${deliveries[0].outcome}`;
  });

  await check("schedule-fires-via-alarm", async () => {
    await seedPrimary();
    if (args.includes("--skip-schedule")) return "skipped";
    const c = alicePrimary;
    const upsert = await c.ok("scheduledTasks.upsert", {
      title: "Every minute", prompt: "Scheduled ping [[fake:text tick]]", enabled: true,
      schedule: { type: "interval", everyMs: 60_000 }, projectId, workspaceStrategy: { type: "root" }, modelSelection: MODEL,
      runtimeMode: "full-access", interactionMode: "default",
    });
    const task = upsert.task ?? upsert;
    assert(task.nextRunAt, "no nextRunAt");
    alicePrimary.close();
    await alicePrimary.closed;
    alicePrimary = null;
    // Put the space to sleep: stop disposes T3; only the DO alarm can wake it now.
    const stopped = await (await http("/control/sp1/_baskule/stop", { method: "POST" })).json();
    const asleep = await (await http("/control/sp1/_baskule/status")).json();
    assert(asleep.awake === false, `still awake after stop: ${JSON.stringify(asleep)} (${JSON.stringify(stopped)})`);
    const dueIn = Date.parse(task.nextRunAt) - Date.now();
    log(`  schedule due in ${Math.round(dueIn / 1000)} s; space asleep`);
    await waitFor("alarm woke the space", async () => (await (await http("/control/sp1/_baskule/status")).json()).awake, dueIn + 30_000, 1000);
    const c2 = await RpcClient.open(BASE, "sp1", alice);
    const ran = await waitFor("scheduled run recorded", async () => {
      const list = await c2.ok("scheduledTasks.list", {});
      const t = list.tasks.find((x) => x.id === task.id);
      return t && t.runCount > 0 ? t : null;
    }, 30_000, 1000);
    await c2.ok("scheduledTasks.setEnabled", { id: task.id, enabled: false });
    c2.close();
    return `ran ${ran.runCount}x (${ran.lastRunStatus}) after an alarm wake`;
  });

  await check("persistence-across-restart", async () => {
    await seedPrimary();
    const environmentIdBefore = (await (await http("/s/sp1/.well-known/t3/environment", { headers: as(alice) })).json()).environmentId;
    await stop("celld");
    await startCelld({ clean: false });
    const c = await RpcClient.open(BASE, "sp1", alice);
    const envAfter = await (await http("/s/sp1/.well-known/t3/environment", { headers: as(alice) })).json();
    assert(envAfter.environmentId && envAfter.environmentId === environmentIdBefore, `environmentId changed: ${environmentIdBefore} → ${envAfter.environmentId}`);
    const projection = await c.ok("orchestration.getThreadProjection", { threadId: firstThreadId });
    const text = JSON.stringify(projection);
    assert(text.includes("PELICAN-42"), "user message lost across the restart");
    assert(text.includes("word") && text.includes("Renamed pelican"), "assistant text or rename lost across the restart");
    // The chat folder record survived too: a follow-up turn opens the provider session in it.
    const thread = watchThread(c, firstThreadId);
    await dispatch(c, { type: "message.dispatch", createdBy: "user", creationSource: "web", threadId: firstThreadId, messageId: `message:after-restart:${crypto.randomUUID()}`, text: "follow-up [[fake:text still here]]", attachments: [], dispatchMode: { type: "queue_after_active" } });
    await waitFor("follow-up answered", () => thread.assistantText().includes("still here"), 60_000);
    const followUp = thread.userMessages().find((m) => m.text.startsWith("follow-up"));
    assert(followUp?.author?.id === alice.userId, `message.dispatch author ${JSON.stringify(followUp?.author)}`);
    thread.stop();
    c.close();
    return "environmentId, history, rename and chat folder intact; follow-up turn answered";
  });

  await check("space-isolation-and-delete", async () => {
    await seedPrimary();
    const c = await RpcClient.open(BASE, "sp2", bob);
    const shell = watchShell(c);
    const pid = (await c.ok("projects.ensureScratch", {})).projectId;
    const tid = await launch(c, pid, "Bob's space [[fake:text ok]]", "Bob chat");
    await waitFor("sp2 thread", () => shell.threads.has(tid), 20_000);
    assert(!shell.threads.has(firstThreadId), "sp1's thread visible in sp2");
    c.close();
    await c.closed;
    const del = await http("/control/sp2/_baskule/delete", { method: "POST" });
    const deleted = await del.json();
    assert(del.ok && deleted.computer?.spaceId === "sp2", `delete ${del.status} ${JSON.stringify(deleted)}`);
    assert(!existsSync(join(RUN, "computers/sp2")), "the computer volume was not deleted");
    const c2 = await RpcClient.open(BASE, "sp2", bob);
    const shell2 = watchShell(c2);
    await waitFor("fresh shell snapshot", () => shell2.ready, 10_000);
    assert(!shell2.threads.has(tid), "deleted space still has its thread");
    c2.close();
    return "two spaces isolated in one isolate; delete wiped sp2";
  });

  await check("status-without-boot", async () => {
    const r = await (await http("/control/sp-never/_baskule/status")).json();
    assert(r.awake === false && r.sockets === 0, JSON.stringify(r));
    const revoke = await (await http("/control/sp-never/_baskule/revoke", { method: "POST", body: JSON.stringify({ userId: "x" }) })).json();
    assert(revoke.closed === 0, JSON.stringify(revoke));
    const again = await (await http("/control/sp-never/_baskule/status")).json();
    assert(again.awake === false, "revoke booted T3");
    return JSON.stringify(r);
  });
}

let exitCode = 1;
try {
  await main();
  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  log(`runner error: ${e?.stack ?? e}`);
} finally {
  const passed = results.filter((r) => r.ok).length;
  log(`${passed}/${results.length} checks passed`);
  if (!args.includes("--keep")) for (const name of Object.keys(procs)) await stop(name);
  else log(`kept running: ${Object.entries(procs).map(([n, p]) => `${n}=${p.pid}`).join(" ")}`);
  process.exit(exitCode);
}
