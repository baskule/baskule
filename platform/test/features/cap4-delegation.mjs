// Capability 4: delegated work and its lifecycle. T3's agent tools reach OpenCode (embedded in the SpaceCell) through the
// platform's space bridge (src/agent/space-bridge.ts) and the fork's BASKULE_MCP_ENDPOINT; T3 registers only the tools
// its policy allows (fork: BASKULE_ALLOWED_MCP_TOOLS, whose content policy.test.ts checks).
import {
  assert, restartCelld, warm, disconnect, fakeRequests, launch, log, projection, reconnect, send, sleep, spaceStatus, waitFor,
  watchShell, watchThread, world,
} from "./lib.mjs";
import { BASKULE_ALLOWED_MCP_TOOLS } from "../../../app/apps/server/src/baskule/rpcPolicy.ts";

const ALLOWED = [...BASKULE_ALLOWED_MCP_TOOLS].sort();

const delegate = (task, title) =>
  `Please delegate [[fake:tool *_delegate_task ${JSON.stringify({ task, title, mode: "async" })}]]`;

/** The delegated task (node) and child thread of a parent, once the parent's delegating turn has run. */
async function taskOf(client, parentId) {
  return waitFor("delegated task node", async () => {
    const p = await projection(client, parentId);
    const node = (p.nodes ?? []).find((n) => String(n.id).startsWith("node:delegated-task:"));
    return node ? { taskId: node.id, node, subagents: p.subagents ?? [] } : null;
  }, 60_000, 500);
}

/**
 * Deliveries of a task's completion to its parent. T3 delivers a completion as a hidden notification that starts a
 * parent run (it is not a visible user message); the fake model answers it with "Fake answer: Delegated task <taskId>
 * (<title>) [<status>]: …", so each delivery is one such parent answer.
 */
async function deliveries(client, parentId, taskId) {
  const p = await projection(client, parentId);
  const prefix = `Fake answer: Delegated task ${taskId}`.slice(0, 92);
  return (p.messages ?? [])
    .filter((m) => m.role === "assistant" && typeof m.text === "string" && m.text.startsWith(prefix))
    .map((m) => ({ ...m, text: m.text.slice("Fake answer: ".length) }));
}

async function idle(spaceId, timeoutMs) {
  return waitFor("no active run in the space (admin status)", async () => {
    const st = await spaceStatus(spaceId).catch(() => null);
    const runs = st?.status?.activeRuns ?? st?.activeRuns;
    return runs === 0 ? st : null;
  }, timeoutMs, 2000);
}

function childIn(shell, parentId) {
  return [...shell.threads.values()].find((t) => t.lineage?.parentThreadId === parentId && t.lineage?.relationshipToParent === "subagent");
}

export const delegationChecks = [
  {
    name: "delegation-tools-filtered",
    capability: "4-delegation",
    fn: async (ctx) => {
      const s = await world(ctx);
      const marker = `tools-${ctx.run}`;
      const threadId = await launch(s.ca, s.projectId, `List tools ${marker} [[fake:text ok]]`, "Tools");
      const t = watchThread(s.ca, threadId);
      await waitFor("turn settled", () => t.settled(), 90_000);
      t.stop();
      const req = (await fakeRequests()).reverse().find((r) => JSON.stringify(r.messages).includes(marker));
      assert(req, "the turn's model request was not captured");
      const names = (req.tools ?? []).map((x) => x.function?.name ?? "");
      const t3 = names.filter((n) => n.startsWith("t3-code-"));
      const server = t3[0]?.replace(/_[a-z0-9_]+$/, "").replace(/_(orchestrator|delegate|task|t3|schedule|list|update|delete|request).*$/, "");
      const suffixes = t3.map((n) => n.slice(n.indexOf("_") + 1)).sort();
      assert(JSON.stringify(suffixes) === JSON.stringify(ALLOWED), `T3 tools offered to the model: ${JSON.stringify(suffixes)} (expected exactly ${JSON.stringify(ALLOWED)})`);
      assert(!names.some((n) => /device_/.test(n)), `unexpected tools: ${names.join(",")}`);
      return `model offered exactly the ${t3.length} allowed T3 tools from server ${server} (no device tools), ${names.length} tools in all`;
    },
  },
  {
    name: "delegation-completes-while-disconnected",
    capability: "4-delegation",
    fn: async (ctx) => {
      const s = await world(ctx);
      const shell = watchShell(s.cb);
      const parentId = await launch(s.ca, s.projectId, delegate("Child job (disconnected) <<fake:long 200>> <<fake:delay 60>>", "Disconnected child"), "Parent A");
      const { taskId } = await taskOf(s.ca, parentId);
      const child = await waitFor("child thread in Bob's shell", () => childIn(shell, parentId), 30_000);
      shell.stop();
      // Nobody is connected while the child works and completes.
      disconnect(ctx);
      const t0 = Date.now();
      await idle(s.team, 120_000);
      const idleAfter = Date.now() - t0;
      await reconnect(ctx);
      const d1 = await waitFor("one delivery", async () => ((await deliveries(s.ca, parentId, taskId)).length >= 1 ? await deliveries(s.ca, parentId, taskId) : null), 60_000, 1000);
      await sleep(5000); // no-fixed-sleep-allow: Observe a second delivery window to detect duplicate completion.
      const d2 = await deliveries(s.ca, parentId, taskId);
      assert(d2.length === 1, `expected exactly one delivery, got ${d2.length}`);
      const shell2 = watchShell(s.ca);
      const c = await waitFor("child status", () => shell2.threads.get(child.id), 20_000);
      shell2.stop();
      return `child ${child.id.slice(-12)} (lineage subagent of the parent) completed with no client connected (space idle after ${Math.round(idleAfter / 1000)} s); parent got exactly 1 delivery: "${d1[0].text.slice(0, 90).replace(/\n/g, " ")}…"; child status ${c.status}`;
    },
  },
  {
    name: "delegation-survives-restart",
    capability: "4-delegation",
    fn: async (ctx) => {
      const s = await world(ctx);
      const shell = watchShell(s.cb);
      const parentId = await launch(s.ca, s.projectId, delegate("Child job (restart) <<fake:long 400>> <<fake:delay 60>>", "Restart child"), "Parent B");
      const { taskId } = await taskOf(s.ca, parentId);
      const parent = watchThread(s.ca, parentId);
      await waitFor("parent's delegating turn settled", () => parent.settled(), 60_000);
      parent.stop();
      const child = await waitFor("child running", () => {
        const c = childIn(shell, parentId);
        return c && /running|working|starting/.test(JSON.stringify(c.status ?? c)) ? c : null;
      }, 30_000).catch(() => childIn(shell, parentId));
      shell.stop();
      disconnect(ctx);
      log("  restarting celld while the child runs");
      restartCelld();
      // No client: the cells come back by their alarms (T3: active runs; OpenCode: active sessions).
      await idle(s.team, 240_000);
      await reconnect(ctx);
      await waitFor("delivery after restart", async () => {
        const d = await deliveries(s.ca, parentId, taskId);
        return d.length ? d : null;
      }, 90_000, 2000);
      log("  restarting celld again (no duplicate delivery)");
      disconnect(ctx);
      restartCelld();
      await reconnect(ctx);
      await sleep(8000); // no-fixed-sleep-allow: Observe redelivery after the second restart to detect duplicates.
      const d2 = await deliveries(s.ca, parentId, taskId);
      assert(d2.length === 1, `expected exactly one delivery after two restarts, got ${d2.length}`);
      await warm(ctx);
      const shell2 = watchShell(s.ca);
      await waitFor("child shell snapshot", () => shell2.ready, 20_000);
      const status = shell2.threads.get(child?.id)?.status;
      shell2.stop();
      return `child ${child?.id?.slice(-12)} was running when celld restarted; with no client connected the space recovered and the task ended "${status}"; parent got exactly 1 delivery, still 1 after a second restart`;
    },
  },
  {
    name: "delegation-cancel-by-agent",
    capability: "4-delegation",
    fn: async (ctx) => {
      const s = await world(ctx);
      const shell = watchShell(s.cb);
      const parentId = await launch(s.ca, s.projectId, delegate("Endless child <<fake:long 3000>> <<fake:delay 60>>", "Cancelled child"), "Parent C");
      const { taskId } = await taskOf(s.ca, parentId);
      const parent = watchThread(s.ca, parentId);
      await waitFor("parent's first turn settled", () => parent.settled(), 60_000);
      await waitFor("child thread", () => childIn(shell, parentId), 30_000);
      await waitFor("child active", () => /running|working/.test(JSON.stringify(childIn(shell, parentId)?.status)), 30_000);
      await send(s.ca, parentId, `Cancel it [[fake:tool *_task_cancel ${JSON.stringify({ taskId, reason: "not needed" })}]]`);
      await waitFor("cancel turn answered", () => parent.assistantText().includes("task_cancel="), 60_000);
      const result = parent.assistantText().slice(parent.assistantText().indexOf("task_cancel="));
      const st = await idle(s.team, 60_000);
      const before = (await fakeRequests()).length;
      await sleep(4000); // no-fixed-sleep-allow: Observe an extra delivery/model-call window after completion or cancellation.
      const after = (await fakeRequests()).length;
      const c = childIn(shell, parentId);
      shell.stop();
      parent.stop();
      const d = await deliveries(s.ca, parentId, taskId);
      assert(/cancel/.test(result), `task_cancel result: ${result.slice(0, 300)}`);
      assert(after === before, `the model kept being called after the cancel (${before} → ${after})`);
      return `task_cancel → ${result.slice(12, 140)}; child status ${c?.status}; space activeRuns ${st.status?.activeRuns ?? st.activeRuns}; no further model calls; deliveries to the parent: ${d.length}`;
    },
  },
  {
    name: "delegation-stop-child-by-user",
    capability: "4-delegation",
    fn: async (ctx) => {
      const s = await world(ctx);
      const shell = watchShell(s.cb);
      const parentId = await launch(s.ca, s.projectId, delegate("Long child <<fake:long 3000>> <<fake:delay 60>>", "Stopped child"), "Parent D");
      const { taskId } = await taskOf(s.ca, parentId);
      const child = await waitFor("child thread", () => childIn(shell, parentId), 30_000);
      await waitFor("child active", () => /running|working/.test(JSON.stringify(childIn(shell, parentId)?.status)), 30_000);
      // Bob (another member) stops the child chat the way the UI's Stop does.
      await s.cb.ok("orchestration.dispatchCommand", { type: "thread.stop", commandId: crypto.randomUUID(), threadId: child.id });
      await idle(s.team, 60_000);
      const d = await waitFor("parent told once", async () => {
        const x = await deliveries(s.ca, parentId, taskId);
        return x.length ? x : null;
      }, 60_000, 1000);
      await sleep(4000); // no-fixed-sleep-allow: Observe an extra delivery/model-call window after completion or cancellation.
      const d2 = await deliveries(s.ca, parentId, taskId);
      shell.stop();
      assert(d2.length === 1, `deliveries ${d2.length}`);
      return `Bob stopped the child chat; the task ended and the parent got exactly 1 delivery: "${d[0].text.slice(0, 120).replace(/\n/g, " ")}"`;
    },
  },
];
