import { test, expect } from "./fixtures.mjs";
import { readFileSync } from "node:fs";

test("configured model replaces retired selections and streams a server-stamped author", { tag: ["@feature:personal-chat"] }, async ({ people, api, fakeLlm }) => {
  const c = await people.alice.rpc(api.personalSpace(people.alice));
  try {
    const projectId = (await c.ok("projects.ensureScratch", {})).projectId;
    const marker = `start-${crypto.randomUUID().slice(0, 8)}`;
    const launched = await c.ok("orchestration.launchThread", {
      commandId: crypto.randomUUID(), projectId, title: `Order ${marker}`, generateTitle: false,
      modelSelection: { instanceId: "opencode", model: "custom/retired-model" },
      runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" },
      initialMessage: { text: `Order ${marker} [[fake:long 80]] [[fake:delay 40]]`, attachments: [], author: { id: "forged", name: "Mallory" } },
    });
    const state = api.watchThread(c, launched.threadId);
    await api.waitFor("answered on configured model", () => state.settled() && state.assistantText().includes("word80"));
    expect(state.assistantUpdates).toBeGreaterThanOrEqual(2);
    expect(state.userMessages()[0].author).toMatchObject({ id: people.alice.me.user.id, name: "Alice" });
    const run = [...state.runs.values()][0];
    expect(run.workStartedAt).toBe(run.requestedAt);
    const requests = await fakeLlm.requests();
    const list = Array.isArray(requests) ? requests : requests.requests;
    expect(list.some((r) => JSON.stringify(r).includes(marker))).toBe(true);
    expect(list.filter((r) => JSON.stringify(r).includes(marker)).every((r) => r.model === "fake-model")).toBe(true);
    await expect.poll(async () => {
      const config = await c.ok("server.getConfig", {});
      return config.providers.map((p) => ({ instanceId: p.instanceId, models: p.models.map((m) => m.slug) }));
    }, { message: "configured model catalog hydrated", timeout: 60_000 }).toEqual([{ instanceId: "opencode", models: ["custom/fake-model"] }]);
    state.stop();
  } finally { c.close(); await c.closed; }
});


test("a new chat generates its title after starting exactly one session", { tag: ["@feature:personal-chat"] }, async ({ people, api, stack }) => {
  const c = await people.alice.rpc(api.personalSpace(people.alice));
  try {
    const projectId = (await c.ok("projects.ensureScratch", {})).projectId;
    const marker = `start-${crypto.randomUUID().slice(0, 8)}`;
    const shell = api.watchShell(c);
    const title = "Fake chat title";
    const initial = `Order ${marker}`;
    const id = await api.launch(c, projectId, `Order ${marker} [[fake:text ok]]`, initial, { generateTitle: true });
    const state = api.watchThread(c, id);
    await api.waitFor("answer", () => state.settled() && state.assistantText().includes("ok"));
    await api.waitFor("generated title committed", () => shell.threads.get(id)?.title === title && shell.threads.get(id)?.titleRegeneration === null);
    expect(shell.threads.get(id).title).not.toBe(initial);
    const run = [...state.runs.values()][0];
    expect(run.workStartedAt).toBe(run.requestedAt);
    const log = readFileSync(stack.logs.celld, "utf8");
    const sessions = [...log.matchAll(/^(\S+)\s.*\[agent [^\]]+\] session ses_\w+ at (\S+)/gm)].filter((m) => m[2].includes(marker));
    expect(sessions.filter((m) => Date.parse(m[1]) < Date.parse(run.startedAt))).toHaveLength(1);
    state.stop(); shell.stop();
  } finally { c.close(); await c.closed; }
});

test("search, snooze, pin, unread, fork and queue controls commit observable state", { tag: ["@feature:conversation-controls", "@feature:team-chat"] }, async ({ people, api }) => {
  const c = await people.alice.rpc(people.team);
  try {
    const shell = api.watchShell(c);
    const projectId = (await c.ok("projects.ensureScratch", {})).projectId;
    const id = await api.launch(c, projectId, "Remember PELICAN-42 [[fake:text alpha]]");
    const state = api.watchThread(c, id);
    await api.waitFor("answer", () => state.settled());
    await api.dispatch(c, { type: "thread.metadata.update", threadId: id, title: "Renamed pelican" });
    await api.waitFor("rename", () => shell.threads.get(id)?.title === "Renamed pelican");
    expect(JSON.stringify(await c.ok("orchestration.searchThreads", { query: "PELICAN-42" }))).toContain(id);
    expect((await c.ok("orchestration.searchThread", { threadId: id, query: "PELICAN" })).totalMatches).toBe(1);
    const until = new Date(Date.now() + 3600000).toISOString();
    await api.dispatch(c, { type: "thread.snooze", threadId: id, snoozedUntil: until });
    await api.waitFor("snoozed", () => Date.parse(shell.threads.get(id)?.snoozedUntil) === Date.parse(until));
    await api.dispatch(c, { type: "thread.unsnooze", threadId: id, reason: "user" });
    await api.waitFor("unsnoozed", () => shell.threads.get(id)?.snoozedUntil === null);
    await api.dispatch(c, { type: "thread.pin", threadId: id });
    await api.waitFor("pinned", () => shell.threads.get(id)?.pinnedAt != null);
    await api.dispatch(c, { type: "thread.unpin", threadId: id });
    await api.waitFor("unpinned", () => shell.threads.get(id)?.pinnedAt === null);
    await api.dispatch(c, { type: "thread.visit", threadId: id, visitedAt: new Date().toISOString() });
    const visited = await api.waitFor("visited", () => shell.threads.get(id)?.lastVisitedAt);
    await api.dispatch(c, { type: "thread.mark-unread", threadId: id });
    await api.waitFor("unread", () => shell.threads.get(id)?.lastVisitedAt !== visited && Date.parse(shell.threads.get(id)?.lastVisitedAt) < Date.parse([...state.runs.values()][0].completedAt));
    const forkId = crypto.randomUUID();
    await api.dispatch(c, { type: "thread.fork", createdBy: "user", creationSource: "web", sourceThreadId: id, targetThreadId: forkId, sourcePoint: { type: "latest_stable" }, title: "Forked pelican" });
    await api.waitFor("fork", () => shell.threads.has(forkId));
    expect(JSON.stringify(await c.ok("orchestration.getThreadProjection", { threadId: forkId }))).toContain("PELICAN-42");
    const qid = await api.launch(c, projectId, "Queue [[fake:long 400]] [[fake:delay 40]]");
    const q = api.watchThread(c, qid);
    await api.waitFor("running", () => [...q.runs.values()].some((r) => r.status === "running"));
    await api.send(c, qid, "queued follow-up");
    const queued = await api.waitFor("queued", () => [...q.runs.values()].find((r) => r.status === "queued"));
    await api.dispatch(c, { type: "queued-run.edit", threadId: qid, runId: queued.id, text: "edited follow-up" });
    await api.waitFor("queue edit", () => q.userMessages().some((m) => m.text === "edited follow-up"));
    await api.dispatch(c, { type: "queued-run.cancel", threadId: qid, runId: queued.id });
    await api.waitFor("cancelled", () => q.runs.get(queued.id)?.status === "cancelled");
    await api.dispatch(c, { type: "thread.stop", threadId: qid });
    await api.waitFor("stopped", () => q.settled());
    await api.dispatch(c, { type: "thread.archive", threadId: qid });
    await api.waitFor("archived", async () => JSON.stringify(await c.ok("orchestration.getArchivedShellSnapshot", {})).includes(qid));
    state.stop(); q.stop(); shell.stop();
  } finally { c.close(); await c.closed; }
});
