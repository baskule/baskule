import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { MODEL, adminSession, assert, cx, fakeRequests, launch, projection, reconnect, waitFor, watchShell, watchThread, world } from "./lib.mjs";

export const pluginChecks = [{ name: "plugin-runtime", capability: "6-plugins", fn: async ctx => {
  const calls = [];
  const key = `organization-test-key-${ctx.run}`;
  const vendor = http.createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401).end(); return; }
    res.setHeader("content-type", "application/json");
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "organization-fixture", version: "1" } };
    if (body.method === "tools/list") result = { tools: [{ name: "org_lookup", description: "Organization fixture", inputSchema: { type: "object", properties: {} } }] };
    if (body.method === "tools/call") { calls.push(body.params); result = { content: [{ type: "text", text: "organization-result" }] }; }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: result ?? {} }));
  });
  vendor.listen(0, "127.0.0.1"); await once(vendor, "listening");
  let plugin; let group;
  const admin = await adminSession();
  try {
    const s = await world(ctx);
    const files = {
      "plugin.json": Buffer.from(JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "runtime-fixture" })),
      "mcp.json": Buffer.from(JSON.stringify({ mcpServers: { organization: { type: "http", url: `http://127.0.0.1:${vendor.address().port}/mcp` } } })),
      "skills/greeting/SKILL.md": Buffer.from("---\nname: greeting\ndescription: Runtime fixture greeting\n---\nUse the greeting fixture.\n"),
      "skills/greeting/assets/data.bin": Buffer.from([0, 1, 127, 255]),
    };
    const archive = Buffer.from(zipSync(files));
    plugin = await admin.json("POST", "/api/baskule/admin/plugins", { groups: [], source: { type: "archive", sha256: createHash("sha256").update(archive).digest("hex") }, archive: archive.toString("base64") });
    assert(plugin.skills.length === 1 && plugin.servers.length === 1, `bad import: ${JSON.stringify(plugin)}`);
    await admin.json("PATCH", `/api/baskule/admin/plugins/${plugin.id}`, { enabled: true, servers: [{ name: "organization", credential: "organization" }] });
    await admin.json("PUT", `/api/baskule/admin/plugins/${plugin.id}/secret`, { server: "organization", headers: { Authorization: `Bearer ${key}` } });
    group = await admin.json("POST", "/api/baskule/admin/groups", { name: `Allowed-${ctx.run}`, members: [s.alice.me.user.id], permissions: { canCreateSpaces: false }, plugins: [plugin.id] });
    await s.alice.json("PUT", `/api/baskule/spaces/${s.team}/plugins`, { personalPluginsAllowed: true, disabled: [] });
    await reconnect(ctx);
    const prompt = `[[fake:tool *org_lookup {}]] [[fake:tool skill {"id":"${plugin.id}/greeting"}]] [[fake:tool shell {"command":"cat /sandbox/space/plugins/*/greeting/SKILL.md; stat -c %a /sandbox/space/plugins/*/greeting/SKILL.md"}]]`;
    const id = await launch(s.ca, s.projectId, prompt, "Allowed plugin call");
    const a = watchThread(s.ca, id);
    await waitFor("Alice plugin turn", () => a.settled(), 120_000);
    const pa = await projection(s.ca, id);
    assert(calls.length === 1, `organization server got ${calls.length} calls; ${JSON.stringify(pa).slice(-3000)}`);
    assert(JSON.stringify(pa).includes("organization-result"), "missing organization result");
    assert(!JSON.stringify(pa).includes("Account used:"), "shared keys must not claim a personal account");
    assert(JSON.stringify(pa).includes("Use the greeting fixture"), "skill missing from computer");
    assert(!JSON.stringify(pa).includes("Unable to load skill"), "OpenCode could not load the managed skill");
    assert(JSON.stringify(pa).includes("444"), "skill is writable");
    const asset = await cx(s.team, ["base64", `/sandbox/space/plugins/${plugin.id}/greeting/assets/data.bin`]);
    assert(asset.code === 0 && asset.out.trim() === Buffer.from([0, 1, 127, 255]).toString("base64"), "binary skill asset was corrupted");
    const requests = await fakeRequests();
    assert(requests.some(r => r.messages.some(m => m.role === "tool" && typeof m.content === "string"
      && m.content.includes(`<file>/sandbox/space/plugins/${plugin.id}/greeting/assets/data.bin</file>`))),
    "skill loader did not expose the remote asset to the model");
    assert(requests.some(r => JSON.stringify(r.messages).includes("Runtime fixture greeting")), "skill absent from model catalog");
    assert(!JSON.stringify(requests).includes(key), "credential leaked to model");
    a.stop();
    const taskInput = { title: "Plugin task owner", prompt: "[[fake:tool *org_lookup {}]]", enabled: true,
      schedule: { type: "interval", everyMs: 3600000 }, projectId: s.projectId, threadId: id,
      workspaceStrategy: { type: "root" }, modelSelection: MODEL, runtimeMode: "full-access", interactionMode: "default",
      author: { id: s.bob.me.user.id, name: "Forged Bob" } };
    const { task } = await s.ca.ok("scheduledTasks.upsert", taskInput);
    assert(task.author.id === s.alice.me.user.id, "task owner was not stamped from the socket");
    const edited = await s.cb.ok("scheduledTasks.upsert", { ...taskInput, id: task.id, title: "Edited by Bob" });
    assert(edited.task.author.id === s.alice.me.user.id, "editing transferred task ownership");
    await s.cb.ok("scheduledTasks.runNow", { id: task.id });
    await waitFor("task uses Alice even when Bob triggers it", () => calls.length === 2, 90000);
    await waitFor("bound task settled", async () => (await projection(s.ca, id)).runs.every(r => ["completed", "failed", "cancelled", "interrupted"].includes(r.status)), 90000);
    await s.ca.ok("scheduledTasks.delete", { id: task.id });
    const { task: hook } = await s.ca.ok("scheduledTasks.upsert", { ...taskInput, threadId: null, schedule: { type: "webhook" } });
    const shell = watchShell(s.ca);
    await waitFor("shell snapshot before webhook", () => shell.threads.has(id), 30000);
    const previousThreads = new Set(shell.threads.keys());
    assert((await fetch(hook.webhook.url, { method: "POST", body: "{}" })).ok, "webhook refused");
    await waitFor("fresh webhook thread uses its task owner", () => calls.length === 3, 90000);
    const hookThread = await waitFor("webhook thread", () => [...shell.threads.keys()].find(threadId => !previousThreads.has(threadId)), 30000);
    await waitFor("webhook turn settled", async () => (await projection(s.ca, hookThread)).runs.every(r => ["completed", "failed", "cancelled", "interrupted"].includes(r.status)), 90000);
    shell.stop();
    await s.ca.ok("scheduledTasks.delete", { id: hook.id });
    const denied = await launch(s.cb, s.projectId, "[[fake:tool *org_lookup {}]]", "Denied plugin call");
    const b = watchThread(s.cb, denied);
    await waitFor("Bob plugin refusal", () => b.settled(), 90_000);
    const pb = await projection(s.cb, denied);
    assert(JSON.stringify(pb).includes("This plugin is not available to you here."), `missing policy refusal: ${JSON.stringify(pb).slice(-2000)}`);
    assert(calls.length === 3, "disallowed member reached vendor"); b.stop();
    // Disable the bundle. The same managed tree is emptied before the next computer tool, and MCP tools vanish.
    await s.alice.json("PUT", `/api/baskule/spaces/${s.team}/plugins`, { personalPluginsAllowed: true, disabled: [plugin.id] });
    await reconnect(ctx);
    const removed = await launch(s.ca, s.projectId, '[[fake:tool shell {"command":"find /sandbox/space/plugins -type f | wc -l"}]]', "Removed skills");
    const c = watchThread(s.ca, removed); await waitFor("skill removal", () => c.settled(), 90_000); c.stop();
    const disk = await cx(s.team, ["find", "/sandbox/space/plugins", "-type", "f"]);
    assert(disk.code === 0 && !disk.out.trim(), `retired skill remains: ${disk.out}`);
    return "organization key injected only in cell; Alice allowed, Bob refused in team space; task owner survives edits/triggers and fresh webhook threads; account label; skill catalog, remote skill asset listed to the model, read-only files and removal";
  } finally {
    if (plugin) await admin.json("DELETE", `/api/baskule/admin/plugins/${plugin.id}`).catch(() => {});
    if (group) await admin.json("DELETE", `/api/baskule/admin/groups/${group.id}`).catch(() => {});
    vendor.closeAllConnections(); await new Promise(resolve => vendor.close(resolve));
  }
}}];
