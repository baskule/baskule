// Real Chromium feedback loop; runs the bridge on private test ports and never touches the live stack.
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { WebSocket } from "ws";
const port = Number(process.env.BASKULE_BROWSER_TEST_PORT ?? 47812);
const fixture = NodeHttp.createServer((_req, res) =>
  res.end(
    '<title>Shared browser fixture</title><h1>Shared browser</h1><input id="name" autofocus>',
  ),
);
await new Promise((r) => fixture.listen(port + 1, "127.0.0.1", r));
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "baskule-browser-"));
const binary =
  process.env.BASKULE_BROWSER_BINARY ??
  NodePath.resolve(import.meta.dirname, "../../../dist-browser/bridge.mjs");
let child;
let viewer;
let log = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function start(profile) {
  child = NodeChildProcess.spawn(process.execPath, [binary], {
    env: {
      ...process.env,
      BASKULE_BROWSER_HOME: profile,
      BASKULE_BROWSER_PORT: String(port),
      CHROME_PATH: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {}
    if (child.exitCode !== null) throw new Error(log);
    await sleep(100);
  }
  throw new Error("bridge did not start: " + log);
}
async function stop() {
  if (!child) return;
  const process = child;
  child = null;
  const done = new Promise((r) => process.once("exit", r));
  process.kill("SIGTERM");
  await done;
}
async function call(method, input) {
  const r = await fetch(`http://127.0.0.1:${port}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, input }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error);
  return body.result;
}
const automate = (operation, input = {}, tabId) =>
  call("automation", {
    operation,
    input,
    ...(tabId ? { tabId } : {}),
    threadId: "smoke",
    agentSessionId: "agent",
    timeoutMs: 60000,
  });
try {
  await start(NodePath.join(root, "space-a"));
  const tab = await automate("open", { url: `http://127.0.0.1:${port + 1}` });
  NodeAssert.ok(tab.tabId);
  NodeAssert.equal(tab.title, "Shared browser fixture");
  const listed = await call("list", { threadId: "smoke" });
  NodeAssert.equal(listed.sessions[0].tabId, tab.tabId);
  const messages = [];
  let frames = 0;
  viewer = new WebSocket(
    `ws://127.0.0.1:${port}/ws?threadId=smoke&tabId=${encodeURIComponent(tab.tabId)}`,
  );
  viewer.on("message", (data, binary) => {
    if (binary) {
      frames++;
      viewer.send(JSON.stringify({ type: "ack" }));
    } else messages.push(JSON.parse(data));
  });
  await new Promise((r, reject) => {
    viewer.once("open", r);
    viewer.once("error", reject);
  });
  async function waitFor(predicate) {
    for (let i = 0; i < 300; i++) {
      if (predicate()) return;
      await sleep(100);
    }
    throw new Error("viewer timed out: " + JSON.stringify(messages));
  }
  await waitFor(() => frames > 0);
  viewer.send(JSON.stringify({ type: "takeControl" }));
  await waitFor(() => messages.some((m) => m.type === "control" && m.controller === "you"));
  await NodeAssert.rejects(
    automate("evaluate", { expression: "document.title" }, tab.tabId),
    /human|control/i,
  );
  await NodeAssert.rejects(
    automate("navigate", { url: `http://127.0.0.1:${port + 1}/blocked` }, tab.tabId),
    /human|control/i,
  );
  viewer.send(JSON.stringify({ type: "text", text: "Human input" }));
  await sleep(300);
  messages.length = 0;
  viewer.send(JSON.stringify({ type: "releaseControl" }));
  await waitFor(() => messages.some((m) => m.type === "control" && m.controller === "agent"));
  const field = await automate(
    "evaluate",
    { expression: "document.querySelector('input').value" },
    tab.tabId,
  );
  NodeAssert.match(JSON.stringify(field), /Human input/);
  await automate(
    "evaluate",
    {
      expression:
        "localStorage.setItem('login','saved'); document.cookie='session=preserved;max-age=3600'; 'saved'",
    },
    tab.tabId,
  );
  viewer.close();
  viewer = null;
  await stop();
  await start(NodePath.join(root, "space-a"));
  const reopened = await automate("open", { url: `http://127.0.0.1:${port + 1}` });
  const saved = await automate(
    "evaluate",
    { expression: "({login:localStorage.getItem('login'),cookie:document.cookie})" },
    reopened.tabId,
  );
  NodeAssert.match(JSON.stringify(saved), /saved/);
  NodeAssert.match(JSON.stringify(saved), /session=preserved/);
  await stop();
  await start(NodePath.join(root, "space-b"));
  await NodeAssert.rejects(
    automate("evaluate", { expression: "document.cookie" }, reopened.tabId),
    /not found|does not exist|no.*tab/i,
  );
  const isolated = await automate("open", { url: `http://127.0.0.1:${port + 1}` });
  const clean = await automate(
    "evaluate",
    { expression: "({login:localStorage.getItem('login'),cookie:document.cookie})" },
    isolated.tabId,
  );
  NodeAssert.doesNotMatch(JSON.stringify(clean), /saved|session=preserved/);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "real navigation",
        "shared tab list",
        "JPEG viewer frames",
        "human takeover blocks agent",
        "human text input",
        "release resumes agent",
        "profile survives restart",
        "space profiles isolated",
        "foreign-space tab rejected",
      ],
      frames,
    }),
  );
} finally {
  viewer?.close();
  await stop();
  fixture.close();
  if (!process.env.KEEP_PROFILE) await NodeFSP.rm(root, { recursive: true, force: true });
  else console.log(root);
}
