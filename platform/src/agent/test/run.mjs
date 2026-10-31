#!/usr/bin/env node
import { waitFor } from "../../space/test/rpc-client.mjs";
// Embedded AgentRuntime checks, through the merged SpaceCell (harness /a/<space>/… → /_baskule/agent/…), on celld
// dev + real computerd v2 + the shared private OpenShell gateway + fake LLM (devstack.sh).
//   node test/run.mjs [--only name,name] [--real-llm]
// Each run uses fresh space ids (computers are deleted at the end). Requires `./devstack.sh start` (run.sh does it).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, http, HARNESS, FAKE_LLM, cd, cdRun } from "./client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A minimal Streamable-HTTP MCP server (JSON answers) with the given tools; tools/call echoes. */
function fakeMcpServer(port, tools) {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      if (req.method !== "POST") return res.writeHead(req.method === "DELETE" ? 200 : 405).end();
      const m = JSON.parse(raw);
      if (process.env.VERBOSE) console.log("fake MCP <", m.method);
      if (m.id === undefined) return res.writeHead(202).end();
      const result =
        m.method === "initialize" ? { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-t3", version: "1" } }
        : m.method === "tools/list" ? { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) }
        : m.method === "tools/call" ? { content: [{ type: "text", text: `called ${m.params.name}` }] }
        : m.method === "ping" ? {} : undefined;
      res.writeHead(200, { "content-type": "application/json", ...(m.method === "initialize" ? { "mcp-session-id": "s1" } : {}) });
      res.end(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } } : { jsonrpc: "2.0", id: m.id, result }));
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const REAL = args.includes("--real-llm");
const run = Math.random().toString(36).slice(2, 7);
const spaces = new Set();
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const space = (name) => { const id = `t${run}${name}`.slice(0, 16); spaces.add(id); return id; };
const assert = (cond, msg, extra) => { if (!cond) throw new Error(`${msg}${extra === undefined ? "" : `: ${JSON.stringify(extra).slice(0, 600)}`}`); };
const phase = async (id) => (await cd("GET", `/spaces/${id}/computer`)).data.phase;
// the last agent-loop request (title generations carry no tools)
const lastLlm = async () => (await http("GET", FAKE_LLM + "/_fake/requests")).data.filter((r) => r.messages && r.tools).at(-1);
const toolOut = (r, i = 0) => { const t = r.tools.filter((x) => x.type === "session.tool.success")[i]; return t ? t.data.content.map((c) => c.text ?? "").join("") : null; };
const failed = (r) => r.tools.filter((x) => x.type === "session.tool.failed").map((x) => x.data.error?.message);

async function check(name, fn) {
  if (only && !only.includes(name)) return;
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, info });
    console.log(`PASS ${name} (${Date.now() - t0} ms)${info ? ` ${typeof info === "string" ? info : JSON.stringify(info)}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) });
    console.log(`FAIL ${name} (${Date.now() - t0} ms): ${e?.message ?? e}`);
    if (process.env.VERBOSE) for (const ag of [A, B]) console.log((await ag.ctl("GET", "/debug/state").catch(() => ({ data: {} }))).data.logs?.slice(-15).join("\n"));
  }
}

const A = new Agent(space("main"));
const B = new Agent(space("bare"));
let mainSid;
const chat = (n) => `/sandbox/space/chats/2026-10-23-test-${n}`;
const fileChat = chat("files");

if (REAL) {
  await check("real-model-shell", async () => {
    const R = new Agent(space("real"));
    const s = await R.createSession({ location: { directory: chat("real") } });
    const r = await R.turn(s.id, "Use the shell tool to run exactly this command and reply with its output only: echo baskule-$((6*7)) && uname -s");
    assert(r.outcome === "succeeded", "turn did not succeed", r);
    const out = toolOut(r);
    assert(out?.includes("baskule-42"), "shell output missing", r.tools);
    const info = (await R.oc("GET", `/api/session/${s.id}`)).data.data;
    return { answer: r.text.slice(0, 120), tokens: info.tokens, cost: info.cost };
  });
} else {
  await http("POST", FAKE_LLM + "/_fake/reset");

  await check("native-continuation-keeps-request-owner", async () => {
    for (const mode of ["promise", "callback"]) {
      const id = crypto.randomUUID();
      const call = async operation => (await http(operation === "status" ? "GET" : "POST",
        `${HARNESS}/_test/continuation/${operation}?id=${id}&mode=${mode}`)).data;
      try {
        await call("start");
        await waitFor("first continuation wait", async () => (await call("status")).phase === "first", 5000);
        await call("release");
        await waitFor("second continuation wait", async () => (await call("status")).phase === "second", 5000);
        await call("release");
        await waitFor(`${mode} native fetch completion`, async () => (await call("status")).phase === "completed", 5000);
        assert((await call("status")).output === "native continuation completed", "outbound fetch did not complete");
      } finally { await call("stop"); }
    }
  });

  await check("plain-chat-no-computer", async () => {
    const s = await A.createSession({ title: "plain", location: { directory: chat("plain"), workspaceID: null }, model: null, parentID: null, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
    mainSid = s.id;
    const r = await A.turn(s.id, "Say hello");
    assert(r.outcome === "succeeded", "turn failed", r);
    assert(r.text.includes("Fake answer: Say hello"), "unexpected answer", r.text);
    const req = await lastLlm();
    const names = req.tools.map((t) => t.function.name);
    for (const t of ["shell", "read", "write", "edit", "glob", "grep", "decision_decision", "webfetch", "websearch", "execute"]) assert(names.includes(t), `tool ${t} not offered`, names);
    const system = JSON.stringify(req.messages.filter((m) => m.role === "system"));
    assert(system.includes("# Code Mode"), "Code Mode instructions missing");
    assert(JSON.stringify(req.messages[0]).includes("You are Baskule"), "assistant prompt missing");
    const p = await phase(A.space);
    assert(p === "absent" || p === "stopped", "a computer was started by a plain chat", p);
    return { computer: p, tools: names.length, codeMode: true, browserCatalog: system.includes("tools.browser.") };
  });

  await check("native-callback-cancellation-keeps-cleanup", async () => {
    const id = crypto.randomUUID();
    const call = async operation => (await http(operation === "status" ? "GET" : "POST",
      `${HARNESS}/_test/continuation/${operation}?id=${id}&mode=cancel`)).data;
    try {
      await call("start");
      await waitFor("cancellable continuation", async () => (await call("status")).phase === "first", 5000);
      await call("release");
      const cleaning = await call("status");
      assert(cleaning.phase === "cleaning" && cleaning.output === undefined, "queued resume bypassed pending cleanup", cleaning);
      await call("finish-cleanup");
      await waitFor("interruption cleanup", async () => (await call("status")).phase === "interrupted", 5000);
      assert((await call("status")).output === "cleanup", "continuation ran after interruption");
    } finally { await call("stop"); }
  });

  await check("sdk-close-settles-pending-stream", async () => {
    const R = new Agent(space("close-stream"));
    await R.createSession({ title: "pending stream" });
    const response = await fetch(`${R.base}/oc/api/event`, { signal: AbortSignal.timeout(15000) });
    const reader = response.body.getReader();
    try {
      assert(!(await reader.read()).done, "SDK event stream closed before shutdown");
      const ended = (async () => { while (!(await reader.read()).done) {} })().catch(() => {});
      assert((await R.ctl("GET", "/debug/state")).data.openStreams === 1, "SDK has no pending event stream");
      const disposed = await fetch(`${R.base}/_baskule/debug/dispose`, { method: "POST", signal: AbortSignal.timeout(10000) });
      assert(disposed.status === 200, "SDK close did not finish", disposed.status);
      await ended;
      const state = (await R.ctl("GET", "/debug/state")).data;
      assert(!state.booted && state.openStreams === 0, "SDK stream remained open after close", state);
    } finally { await reader.cancel().catch(() => {}); }
  });

  await check("shell-ensures-computer", async () => {
    const s = await A.createSession({ location: { directory: chat("shell") } });
    const r = await A.turn(s.id, 'Run [[fake:tool shell {"command":"pwd; id -u; echo $HOME; python3 -c \\"print(6*7)\\""}]]');
    assert(r.outcome === "succeeded", "shell session did not finish", r);
    const out = toolOut(r);
    assert(out?.includes(chat("shell")) && out.includes("1000") && out.includes("/sandbox/space/home") && out.includes("42"), "shell output", { out, failed: failed(r), outcome: r.outcome, error: r.error, events: r.events });
    assert((await phase(A.space)) === "ready", "computer not ready");
    assert(r.text.includes("Done"), "fake model did not get the tool result", r.text);
    return out.trim().split("\n").join(" | ");
  });

  await check("file-tools", async () => {
    const s = await A.createSession({ location: { directory: fileChat } });
    const steps = [
      ['write', { path: "notes.txt", content: "alpha\nbeta\ngamma\n" }],
      ['read', { path: "notes.txt" }],
      ['edit', { path: "notes.txt", oldString: "beta", newString: "BETA" }],
      ['glob', { pattern: "*.txt" }],
      ['grep', { pattern: "BETA" }],
    ];
    const outs = {};
    for (const [tool, input] of steps) {
      const r = await A.turn(s.id, `[[fake:tool ${tool} ${JSON.stringify(input)}]]`);
      assert(r.tools.length === 1 && r.tools[0].type === "session.tool.success", `${tool} failed`, { failed: failed(r), tools: r.tools });
      outs[tool] = toolOut(r);
    }
    assert(outs.read.includes("beta"), "read", outs.read);
    assert(outs.glob.includes("notes.txt"), "glob", outs.glob);
    assert(outs.grep.includes("notes.txt"), "grep", outs.grep);
    const cat = await cdRun(A.space, ["cat", `${fileChat}/notes.txt`]);
    assert(cat.out === "alpha\nBETA\ngamma\n", "file content on the computer", cat);
    // patch: OpenCode swaps edit/write for `patch` on gpt-* models; the debug model gpt-fake-patch exercises it.
    const p = await A.createSession({ location: { directory: fileChat }, model: { providerID: "custom", id: "gpt-fake-patch" } });
    const patchText = "*** Begin Patch\n*** Update File: notes.txt\n@@\n alpha\n-BETA\n+beta-patched\n*** Add File: added.md\n+# added by patch\n*** End Patch";
    const r = await A.turn(p.id, `[[fake:tool patch ${JSON.stringify({ patchText })}]]`);
    assert(r.tools[0]?.type === "session.tool.success", "patch failed", { failed: failed(r) });
    const cat2 = await cdRun(A.space, ["sh", "-c", `cat ${fileChat}/notes.txt ${fileChat}/added.md`]);
    assert(cat2.out === "alpha\nbeta-patched\ngamma\n# added by patch\n", "patched content", cat2);
    return "write/read/edit/glob/grep/patch on the computer";
  });

  await check("large-tool-output-readable-on-computer", async () => {
    const s = await A.createSession({ location: { directory: chat("spill") }, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
    const recent = [];
    for (const tool of ["shell", "execute"]) for (const multiline of [false, true]) {
      const seeded = await cdRun(A.space, ["sh", "-c", `
        mkdir -p /sandbox/space/tool-output/tool_retention-directory && cd /sandbox/space/tool-output &&
        touch -d '8 days ago' tool_retention-old sh_retention-old keep-retention-old tool_retention-directory &&
        touch -d '6 days ago' tool_retention-recent sh_retention-recent
      `]);
      assert(seeded.code === 0, "could not seed retention fixtures", seeded);
      const text = multiline ? "spill-line\n".repeat(2100) : `spill-begin${"x".repeat(60000)}spill-end`;
      const python = multiline ? 'print("spill-line\\n" * 2100, end="")' : 'print("spill-begin" + "x" * 60000 + "spill-end", end="")';
      const input = tool === "shell" ? { command: `python3 -c '${python}'` }
        : { code: multiline ? 'return "spill-line\\n".repeat(2100)' : 'return "spill-begin" + "x".repeat(60000) + "spill-end"' };
      const r = await A.turn(s.id, `[[fake:tool ${tool} ${JSON.stringify(input)}]]`);
      const t = r.tools.find(t => t.type === "session.tool.success");
      const path = t?.data.metadata?.outputPath;
      assert(t?.data.metadata?.truncated && path?.startsWith("/sandbox/space/tool-output/"), "missing computer spill path", { tool, multiline, metadata: t?.data.metadata, output: toolOut(r)?.slice(-400), failed: failed(r) });
      recent.push(path);
      const retained = await cdRun(A.space, ["sh", "-c", `
        cd /sandbox/space/tool-output &&
        test ! -e tool_retention-old && test ! -e sh_retention-old &&
        test -f tool_retention-recent && test -f sh_retention-recent &&
        test -f keep-retention-old && test -d tool_retention-directory &&
        for path do test -f "$path" || exit 1; done
      `, "sh", ...recent]);
      assert(retained.code === 0, "spill write must prune only aged tool/sh files and keep recent spills", { tool, multiline, retained });
      assert(toolOut(r)?.includes(`full output saved to ${path}`), "model marker must name the computer file", toolOut(r));
      if (tool === "execute" && !multiline) assert(toolOut(r).includes("showing 0 lines"), "single-line byte limit was not exercised", toolOut(r));
      const read = await A.turn(s.id, `[[fake:tool read ${JSON.stringify({ path, limit: 1 })}]]`);
      assert(read.tools[0]?.type === "session.tool.success" && toolOut(read)?.includes(multiline ? "spill-line" : "spill-begin"), "read cannot reach spill", { out: toolOut(read), failed: failed(read) });
      // read bounds individual lines too; shell can retrieve arbitrary byte ranges of the complete file.
      const hash = await A.turn(s.id, `[[fake:tool shell ${JSON.stringify({ command: `sha256sum ${path}` })}]]`);
      assert(toolOut(hash)?.includes(createHash("sha256").update(text).digest("hex")), "full spill content was not preserved", { out: toolOut(hash), failed: failed(hash) });
    }
    return "shell/execute, single line >50 KiB and >2,000 lines: computer path, read, full-content SHA-256 and seven-day tool/sh retention";
  });

  await check("abort-kills-remote-process", async () => {
    const s = await A.createSession({ location: { directory: chat("abort") } });
    let called;
    const calledP = new Promise((r) => (called = r));
    const turn = A.turn(s.id, '[[fake:tool shell {"command":"sleep 97 && echo should-not-print"}]]', { onEvent: (e) => { if (e.type === "session.tool.progress" || e.type === "session.tool.called") called(); } });
    await calledP;
    let running = false;
    for (let i = 0; i < 40 && !running; i++) { await sleep(250); running = (await cdRun(A.space, ["pgrep", "-f", "slee[p] 97"])).code === 0; } // no-fixed-sleep-allow: Poll process creation with a bounded retry count.
    assert(running, "the remote process never started");
    const t0 = Date.now();
    const ir = await A.oc("POST", `/api/session/${s.id}/interrupt`, {});
    assert(ir.status < 300, "interrupt", ir);
    const r = await turn;
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = (await cdRun(A.space, ["pgrep", "-f", "slee[p] 97"])).code !== 0; if (!gone) await sleep(250); } // no-fixed-sleep-allow: Poll process termination with a bounded retry count.
    assert(gone, "the remote process survived the abort");
    return { outcome: r.outcome, killedWithinMs: Date.now() - t0 };
  });

  await check("bare-session-runs-nothing", async () => {
    const before = (await B.ctl("GET", "/debug/state")).data.stats?.execs ?? 0;
    const created = await B.ctl("POST", "/debug/bare-session", { directory: "/tmp/bare" });
    assert(created.status === 200, "bare session", created);
    const sid = created.data.data.id;
    const r = await B.turn(sid, '[[fake:tool shell {"command":"echo should-not-run > /tmp/x; id"}]] [[fake:tool read {"path":"/etc/passwd"}]]');
    const st = (await B.ctl("GET", "/debug/state")).data;
    assert(r.tools.every((t) => t.type === "session.tool.failed"), "a tool succeeded without a computer", r.tools);
    assert(st.stats.execs === before, "an exec reached computerd", st.stats);
    assert(["absent", "stopped"].includes(await phase(B.space)), "a computer was started");
    // and the API refuses a workspace-less location outside /sandbox
    const bad = await B.oc("POST", "/api/session", { location: { directory: "/etc" } });
    assert(bad.status === 400, "session outside /sandbox accepted", bad);
    return failed(r).map((m) => m.slice(0, 80));
  });

  // A runtime MCP server added the way T3 adds its own (PUT /api/experimental/mcp/t3-code-…): its tools are offered at
  // the first step of the next turn, without fixed sleeps (0.2.1).
  await check("empty-plugin-catalog-does-not-block-chat", async () => {
    const E = new Agent(space("empty"));
    const dir = chat("empty-plugin");
    await http("POST", `${HARNESS}/_test/plugins`, { spaceId: E.space, plugins: { skills: [], servers: [{
      pluginId: "unconnected", name: "remote", catalogUserId: "alice", defaultAccountOnly: false, credential: "user-oauth",
      transport: "streamable-http", url: "https://unconnected.invalid/mcp",
    }] } });
    const mcp = await fakeMcpServer(47654, ["preview_open"]);
    try {
      const s = await E.createSession({ location: { directory: dir } });
      const put = await fetch(`${E.base}/oc/api/experimental/mcp/t3-code-empty?location[directory]=${encodeURIComponent(dir)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ config: { type: "remote", url: "http://127.0.0.1:47654/mcp", oauth: false } }),
      });
      assert(put.status === 204, "MCP registration must complete within T3's deadline", put.status);
      const r = await E.turn(s.id, '[[fake:tool t3-code-empty_preview_open {"url":"https://example.com"}]]');
      assert(r.outcome === "succeeded", "chat with an unconnected plugin did not complete", r);
      assert(toolOut(r)?.includes("called preview_open"), "first-step browser tool missing", r.tools);
      return "empty plugin catalog accepted; browser tool offered and execution completed";
    } finally { mcp.close(); }
  });

  await check("runtime-mcp-at-first-step", async () => {
    const catalog = ["preview_open", "task_status"];
    const mcp = await fakeMcpServer(47654, catalog);
    try {
      const s = await A.createSession({ location: { directory: chat("mcp") } });
      const t0 = Date.now();
      const put = await A.oc("PUT", `/api/experimental/mcp/t3-code-abc?location[directory]=${encodeURIComponent(chat("mcp"))}`, { config: { type: "remote", url: "http://127.0.0.1:47654/mcp", oauth: false } });
      const putMs = Date.now() - t0;
      assert(put.status === 204, "mcp add", put);
      const r = await A.turn(s.id, '[[fake:tool t3-code-abc_preview_open {"url":"https://example.com"}]]');
      const names = (await lastLlm()).tools.map((t) => t.function.name);
      assert(names.includes("t3-code-abc_preview_open") && names.includes("t3-code-abc_task_status"), "runtime MCP tools missing at the first step", names);
      assert(toolOut(r)?.includes("called preview_open"), "tool call", { failed: failed(r) });
      catalog.length = 0;
      const replace = await A.oc("PUT", `/api/experimental/mcp/t3-code-abc?location[directory]=${encodeURIComponent(chat("mcp"))}`, { config: { type: "remote", url: "http://127.0.0.1:47654/mcp?empty", oauth: false } });
      assert(replace.status === 204, "empty replacement catalog rejected", replace);
      const next = await A.turn(s.id, "The plugin catalog is now empty. Say hello.");
      const replacedNames = (await lastLlm()).tools.map(t => t.function.name);
      assert(next.outcome === "succeeded" && !replacedNames.some(name => name.startsWith("t3-code-abc_")), "obsolete MCP tools still offered after replacement", replacedNames);
      return { putMs };
    } finally {
      mcp.close();
    }
  });

  await check("failed-runtime-mcp-registration-is-reported", async () => {
    const F = new Agent(space("failedmcp"));
    const dir = chat("failed-mcp");
    await F.createSession({ location: { directory: dir } });
    const put = await F.oc("PUT", `/api/experimental/mcp/t3-code-failed?location[directory]=${encodeURIComponent(dir)}`, {
      config: { type: "remote", url: "http://127.0.0.1:1/mcp", oauth: false },
    });
    assert(put.status === 400 && put.data.error === "mcp_failed", "failed registration reported success", put);
    return "failed T3 MCP connection is an explicit registration error";
  });

  await check("image-part-reaches-model", async () => {
    const s = await A.createSession({ location: { directory: chat("image") } });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
    const r = await A.turn(s.id, { text: "What is in this image? [[fake:describe]]", files: [{ uri: `data:image/png;base64,${png}`, name: "dot.png" }, { uri: `data:application/pdf;base64,${pdf}`, name: "doc.pdf" }] });
    assert(r.outcome === "succeeded", "turn", r);
    const parts = (await lastLlm()).messages.filter((m) => m.role === "user").flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const image = parts.find((p) => p.type === "image_url");
    assert(image?.image_url?.url?.startsWith("data:image/png;base64,"), "no image part in the model request", parts.map((p) => p.type));
    const pdfPart = parts.some((p) => p.type === "file" || p.type === "input_file");
    return { image: true, pdfForwarded: pdfPart, answer: r.text.slice(0, 100) };
  });

  await check("two-concurrent-sessions", async () => {
    const [s1, s2] = await Promise.all([A.createSession({ location: { directory: chat("c1") } }), A.createSession({ location: { directory: chat("c2") } })]);
    const cmd = '[[fake:tool shell {"command":"date +%s.%N; sleep 4; date +%s.%N; pwd"}]]';
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([A.turn(s1.id, cmd), A.turn(s2.id, cmd)]);
    assert(r1.outcome === "succeeded" && r2.outcome === "succeeded", "concurrent sessions did not finish", { r1, r2 });
    const o1 = toolOut(r1), o2 = toolOut(r2);
    assert(o1?.includes(chat("c1")) && o2?.includes(chat("c2")), "outputs", { o1, o2, f: [failed(r1), failed(r2)], outcomes: [r1.outcome, r2.outcome], events: [r1.events, r2.events] });
    const [a1, b1] = o1.split("\n").map(Number), [a2, b2] = o2.split("\n").map(Number);
    assert(a1 < b2 && a2 < b1, "the two commands did not overlap", { a1, b1, a2, b2 });
    return { wallMs: Date.now() - t0, overlapS: (Math.min(b1, b2) - Math.max(a1, a2)).toFixed(2) };
  });

  await check("persistence-across-celld-restart", async () => {
    assert(mainSid, "needs plain-chat-no-computer");
    const before = (await A.oc("GET", `/api/session/${mainSid}`)).data.data;
    // let the heartbeat see that no turn is running (it clears the cell's busy flag), so the restart finds it idle
    await waitFor("heartbeat cleared turn keepalives", async () => (await A.ctl("GET", "/debug/state")).data.turnKeepalives === 0, 30_000);
    execFileSync(join(HERE, "devstack.sh"), ["restart-celld"], { stdio: "ignore" });
    const st = (await A.ctl("GET", "/debug/state")).data;
    assert(st.booted === false, "state must not boot OpenCode", st);
    const after = (await A.oc("GET", `/api/session/${mainSid}`)).data.data;
    assert(after?.id === mainSid && after.title === before.title, "session lost", after);
    const list = (await A.oc("GET", "/api/session")).data.data;
    assert(list.length >= 3, "session list", list.length);
    // a new turn in an old chat still reaches its files on the computer
    const s = await A.createSession({ location: { directory: fileChat } });
    const r = await A.turn(s.id, '[[fake:tool shell {"command":"cat notes.txt"}]]');
    assert(r.outcome === "succeeded", "shell session after restart did not finish", r);
    assert(toolOut(r)?.includes("beta-patched"), "files after restart", { out: toolOut(r), f: failed(r) });
    const r2 = await A.turn(mainSid, "Do you remember?");
    assert(r2.outcome === "succeeded", "old session turn", r2);
    return { sessions: list.length };
  });

  await check("restart-mid-chat-keeps-toolset", async () => {
    const R = new Agent(space("restart"));
    const dir = chat("restart");
    const t3Rules = [{ action: "*", resource: "*", effect: "allow" }, { action: "t3-code-*", resource: "*", effect: "deny" }, { action: "t3-code-abc_*", resource: "*", effect: "allow" }];
    const s = await R.createSession({ location: { directory: dir }, permissions: t3Rules });
    const offered = async () => {
      const req = await lastLlm();
      return { names: req.tools.map((t) => t.function.name), system: JSON.stringify(req.messages.filter((m) => m.role === "system")) };
    };
    const expectToolset = ({ names, system }, when) => {
      for (const t of ["shell", "read", "write", "edit", "glob", "grep", "execute", "webfetch", "websearch"]) assert(names.includes(t), `${when}: tool ${t} not offered`, names);
      assert(system.includes("# Code Mode"), `${when}: Code Mode instructions missing`);
    };
    const r1 = await R.turn(s.id, '[[fake:tool shell {"command":"echo one > turn1.txt && cat turn1.txt"}]]');
    assert(toolOut(r1)?.includes("one"), "turn 1 shell", { out: toolOut(r1), f: failed(r1), outcome: r1.outcome, error: r1.error, events: r1.events });
    expectToolset(await offered(), "before the restart");
    execFileSync(join(HERE, "devstack.sh"), ["restart-celld"], { stdio: "ignore" });
    // T3 rewrites permissions when it resumes the same persisted session.
    const patched = await R.oc("PATCH", `/api/session/${s.id}`, { permissions: t3Rules });
    assert(patched.status < 300, "session update", patched);
    const r2 = await R.turn(s.id, '[[fake:tool write {"path":"turn2.txt","content":"two\\n"}]] [[fake:tool shell {"command":"cat turn1.txt turn2.txt"}]]');
    expectToolset(await offered(), "after the restart");
    assert(r2.tools.length === 2 && r2.tools.every((t) => t.type === "session.tool.success"), "turn 2 tools", { failed: failed(r2) });
    assert(toolOut(r2, 1)?.includes("one") && toolOut(r2, 1).includes("two"), "turn 2 shell output", toolOut(r2, 1));
    const cat = await cdRun(R.space, ["cat", `${dir}/turn2.txt`]);
    assert(cat.out === "two\n", "file written on the computer", cat);
    return "shell/write after restart + rules rewrite; webfetch/websearch/execute offered";
  });

  await check("heartbeat-and-idle-dispose", async () => {
    // a turn keeps a 5 s alarm heartbeat; once idle (BASKULE_AGENT_IDLE_S=25 in the harness), OpenCode is closed
    const C = new Agent(space("idle"));
    const s = await C.createSession({ location: { directory: chat("idle") } });
    let alarmDuringTurn = null;
    const turn = C.turn(s.id, '[[fake:tool shell {"command":"sleep 3"}]]', { onEvent: async (e) => {
      if (e.type === "session.tool.called" && alarmDuringTurn === null) alarmDuringTurn = (await C.ctl("GET", "/debug/state")).data.alarm - Date.now();
    } });
    await turn;
    assert(alarmDuringTurn !== null && alarmDuringTurn <= 5_500, "no heartbeat alarm during the turn", alarmDuringTurn);
    let st;
    for (let i = 0; i < 30; i++) { await sleep(2_000); st = (await C.ctl("GET", "/debug/state")).data; if (!st.booted) break; } // no-fixed-sleep-allow: Poll idle disposal with a bounded retry count.
    // OpenCode closed and no agent alarm left. The counter is per runtime instance: the owning SpaceCell may also
    // have replaced its runtime (space dispose/eviction), which is the same observable outcome.
    assert(!st.booted && st.alarm === null, "not disposed when idle", { stats: st.stats, alarm: st.alarm });
    const r = await C.turn(s.id, "still there?");
    assert(r.outcome === "succeeded", "turn after dispose", r);
    return { alarmInMs: alarmDuringTurn, disposes: st.stats.disposes };
  });

  await check("control-routes", async () => {
    const st = await A.cell("GET", "/status");
    assert(st.status === 200 && st.data.awake === false, "status (T3 never boots here)", st);
    const stop = await A.cell("POST", "/stop");
    assert(stop.status === 200 && typeof stop.data.stoppedThreads === "number", "stop", stop);
    const del = await B.cell("POST", "/delete");
    assert(del.status === 200 && del.data.deleted, "delete", del);
    const list = (await B.oc("GET", "/api/session")).data.data;
    assert(Array.isArray(list) && list.length === 0, "sessions left after delete", list);
    return "space status/stop/delete";
  });
}

// Clean up the test computers (sandbox + volume).
for (const id of spaces) await cd("POST", `/spaces/${id}/computer/delete`, { confirm: id }).catch(() => {});
const failedN = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failedN}/${results.length} passed`);
process.exit(failedN ? 1 : 0);
