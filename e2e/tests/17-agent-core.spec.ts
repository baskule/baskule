// Agent core (docs/development-workflow.md):
//  (a) an existing chat resumed after a celld restart keeps the Baskule toolset (live incident, chat 8e340400);
//  (b) a plain chat, and deleting it, never create or start a computer;
//  (c) timings: cold sign-in → composer, new chat first answer, warm turn; celld CPU per turn and memory. A measurement,
//      not a correctness check: tagged @perf, it runs only on request (`e2e/run.sh --project perf`).
import { expect, test } from "@playwright/test";

import {
  computerStatus, cx, fakeRequests, metric, newDevice, openChat, personApi, sendInCurrent, sh, shot, signInBrowser,
  spaceRpc, startChat, until, waitAnswer, waitComposer, waitHealthy, world,
} from "./lib";

const S = "17-agent-core";
const NODES = ["baskule-celld-a", "baskule-celld-b"];

/** Restarts both celld nodes one after the other (a rolling restart, as a redeploy or failover does). */
function rollingRestart(): number {
  const t0 = Date.now();
  for (const c of NODES) {
    sh("docker", ["restart", c], { timeoutMs: 180_000 });
    // A node opens readiness once the fleet has memory headroom: under load this takes minutes.
    waitHealthy(c, 600);
  }
  return Date.now() - t0;
}

/** The tools of the last agent-loop request (title requests carry no tools). */
function lastAgentRequest(): { names: string[] } {
  const req = fakeRequests().filter((r) => r.messages && r.tools).at(-1);
  return { names: req.tools.map((t: any) => t.function.name) };
}

function expectToolset({ names }: { names: string[] }, when: string): void {
  for (const t of ["shell", "read", "glob", "grep"]) expect(names, `${when}: ${t}`).toContain(t);
  // OpenCode offers `patch` instead of write/edit on gpt-* model ids.
  expect(names.some((n) => n === "patch" || n === "write"), `${when}: a file-writing tool`).toBe(true);
  expect(names.some((n) => /^t3-code-.+_preview_open$/.test(n)), `${when}: the shared browser (preview_*)`).toBe(true);
}

/** celld CPU time (µs, both nodes) from their cgroups. */
function celldCpuUs(): number {
  return NODES.map((c) => Number(/usage_usec (\d+)/.exec(sh("docker", ["exec", c, "cat", "/sys/fs/cgroup/cpu.stat"]))?.[1] ?? 0)).reduce((a, b) => a + b, 0);
}
/** celld memory (both nodes): cgroup working set and V8/allocator bytes from /state. */
function celldMemory(): { workingSetMiB: number; inUseMiB: number } {
  let ws = 0;
  let inUse = 0;
  for (const c of NODES) {
    const st = JSON.parse(sh("docker", ["exec", c, "curl", "-s", "127.0.0.1:47092/state"]));
    ws += Number(st.cgroup_working_set_bytes ?? 0);
    inUse += Number(st.in_use_bytes ?? 0);
  }
  return { workingSetMiB: Math.round(ws / 2 ** 20), inUseMiB: Math.round(inUse / 2 ** 20) };
}

// The same-chat restart regression found by the merged full suite (background-event lifetime): keep it unweakened.
test("(a) a chat resumed after a celld restart keeps the Baskule toolset", { tag: ["@lifecycle", "@slow"] }, async ({ browser }) => {
  test.setTimeout(900_000);
  const w = await world();
  const a = await newDevice(browser);
  await signInBrowser(a.page, w.alice);
  await waitComposer(a.page);
  const marker = crypto.randomUUID().slice(0, 8);
  const before = `Restart drill [[fake:tool shell ${JSON.stringify({ command: `echo one > one.txt && echo before-${marker} && cat one.txt` })}]]`;
  const existing = process.env.E2E_RESTART_THREAD_ID;
  let id: string;
  if (existing) {
    id = existing;
    await openChat(a.page, id);
    await sendInCurrent(a.page, before);
  } else id = await startChat(a.page, before, "Personal");
  await waitAnswer(a.page, new RegExp(`before-${marker}`), 180_000);
  expectToolset(lastAgentRequest(), "before the restart");
  const restartMs = rollingRestart();
  await a.page.reload();
  await waitComposer(a.page, 180_000);
  await openChat(a.page, id);
  // While the tab's socket reconnects the composer ignores Enter (the text stays): send again until accepted, as a
  // user would (same as 09-failover).
  await a.page.locator('[contenteditable="true"]').first().fill(`After the restart ${marker} [[fake:tool shell ${JSON.stringify({ command: `echo two > two.txt && echo after-${marker} && cat one.txt two.txt` })}]]`);
  const accepted = a.page.locator('[data-message-role="user"]').filter({ hasText: `After the restart ${marker}` });
  for (let i = 0; i < 90 && !(await accepted.isVisible().catch(() => false)); i++) {
    await a.page.locator('[contenteditable="true"]').first().click();
    await a.page.keyboard.press("Enter");
    await a.page.waitForTimeout(2000); // no-fixed-sleep-allow: Retry sending after restart until the message appears, at most ninety attempts.
  }
  await expect(accepted).toBeVisible();
  await waitAnswer(a.page, new RegExp(`after-${marker}[\\s\\S]*two`), 240_000);
  const after = lastAgentRequest();
  expectToolset(after, "after the restart");
  const folder = cx(w.alice.personal, `ls -d /sandbox/space/chats/*${id.slice(-8)}`).trim().split("\n")[0];
  expect(cx(w.alice.personal, `cat ${folder}/one.txt ${folder}/two.txt`).trim()).toBe("one\ntwo");
  await shot(a.page, S, "01-after-restart");
  metric(S, { check: "restart-toolset", restartMs, tools: after.names.length });
  await a.context.close();
});

test("(b) a plain chat and its deletion never start a computer", { tag: ["@chat", "@computer"] }, async () => {
  const w = await world();
  const bob = await personApi(w.bob);
  const initialPhase = computerStatus(w.bob.personal).phase;
  expect(["absent", "stopped"]).toContain(initialPhase);
  const project = await spaceRpc(bob, w.bob.personal, "projects.ensureScratch", {});
  const launched = await spaceRpc(bob, w.bob.personal, "orchestration.launchThread", {
    commandId: crypto.randomUUID(), projectId: project.value.projectId, title: "Plain", runtimeMode: "full-access", interactionMode: "default",
    modelSelection: { instanceId: "opencode", model: `custom/${process.env.E2E_MODEL ?? "mistral-large-4"}` }, workspaceStrategy: { type: "root" },
    initialMessage: { text: "bonjour [[fake:text Bonjour !]]", attachments: [] },
  });
  expect(launched._tag, JSON.stringify(launched).slice(0, 300)).toBe("Success");
  const threadId = launched.value.threadId;
  await until(async () => {
    const p = await spaceRpc(bob, w.bob.personal, "orchestration.getThreadProjection", { threadId });
    const msgs = p.value?.projection?.messages ?? p.value?.messages ?? [];
    return msgs.some((m: any) => m.role === "assistant" && /Bonjour/.test(m.text ?? ""));
  }, 120_000, 1000, "the plain answer");
  const del = await spaceRpc(bob, w.bob.personal, "orchestration.dispatchCommand", { type: "thread.delete", commandId: crypto.randomUUID(), threadId });
  expect(del._tag).toBe("Success");
  await until(async () => {
    const shell = await spaceRpc(bob, w.bob.personal, "orchestration.searchThreads", { query: "bonjour" });
    return shell._tag === "Success" && Array.isArray(shell.value?.matches) && !shell.value.matches.some((t: { threadId: string }) => t.threadId === threadId);
  }, 30_000, 250, "deleted thread absent from the search index");
  const st = computerStatus(w.bob.personal);
  expect(st.phase, "plain chat and deletion preserve the computer's initial inactive state").toBe(initialPhase);
  metric(S, { check: "plain-chat-delete-lazy", phase: st.phase });
});

test("(c) timings: cold sign-in, new chat, warm turn, CPU and memory", { tag: ["@perf", "@slow"] }, async ({ browser }) => {
  test.setTimeout(900_000);
  const w = await world();
  // Cold: every cell evicted by a rolling restart; the browser loads the app with a valid session.
  rollingRestart();
  const memIdle = celldMemory();
  const a = await newDevice(browser);
  const t0 = Date.now();
  await signInBrowser(a.page, w.alice);
  await waitComposer(a.page, 180_000);
  const coldComposerMs = Date.now() - t0;
  const newChat: number[] = [];
  const warm: number[] = [];
  let cpuWarmUs = 0;
  for (let i = 0; i < 3; i++) {
    let s = Date.now();
    await startChat(a.page, `Chat ${i} [[fake:text answer ${i}]]`, "Personal");
    await waitAnswer(a.page, new RegExp(`answer ${i}`));
    newChat.push(Date.now() - s);
    const cpu0 = celldCpuUs();
    s = Date.now();
    await sendInCurrent(a.page, `Again ${i} [[fake:text again ${i}]]`);
    await waitAnswer(a.page, new RegExp(`again ${i}`));
    warm.push(Date.now() - s);
    cpuWarmUs += celldCpuUs() - cpu0;
  }
  const memActive = celldMemory();
  const med = (x: number[]) => [...x].sort((p, q) => p - q)[1];
  const m = {
    check: "timings", coldComposerMs, newChatAnswerMs: newChat, warmTurnAnswerMs: warm, medianNewChatMs: med(newChat), medianWarmMs: med(warm),
    celldCpuMsPerWarmTurn: Math.round(cpuWarmUs / 3 / 1000), memoryIdle: memIdle, memoryOneSpaceActive: memActive,
  };
  metric(S, m);
  console.log(`agent-core timings: ${JSON.stringify(m)}`);
  await a.context.close();
});
