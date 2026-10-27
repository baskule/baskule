// Capability 1: chat and conversation controls, as two members on two connections (Alice, Bob) of a team space.
import {
  adminSession, assert, disconnect, dispatch, fakeRequests, launch, log, projection, reconnect, send,
  spaceStatus, waitFor, watchShell, watchThread, world,
} from "./lib.mjs";

async function idleSpace(spaceId) {
  return waitFor("no active run", async () => ((await spaceStatus(spaceId).catch(() => null))?.status?.activeRuns === 0 ? true : null), 120_000, 1000);
}

const pending = (p) => (p.runtimeRequests ?? []).filter((r) => r.status === "pending");

async function requestOf(client, threadId, kind) {
  return waitFor(`pending ${kind} request`, async () => {
    const p = await projection(client, threadId);
    return pending(p).find((r) => (kind === "user_input" ? r.kind === "user_input" : r.kind !== "user_input")) ?? null;
  }, 60_000, 500);
}

const resolved = async (client, threadId, requestId) => {
  const p = await projection(client, threadId);
  return (p.runtimeRequests ?? []).find((r) => r.id === requestId);
};

export const chatChecks = [
  {
    name: "chat-search",
    capability: "1-chat",
    fn: async (ctx) => {
      const s = await world(ctx);
      const word = `zebra${ctx.run}`;
      const id = await launch(s.ca, s.projectId, `Quarterly ${word} numbers [[fake:text the ${word} report is ready]]`, "Search target");
      const t = watchThread(s.ca, id);
      await waitFor("turn", () => t.settled(), 90_000);
      t.stop();
      // Bob searches across chats, then inside the chat (request and streamed forms).
      const all = await s.cb.ok("orchestration.searchThreads", { query: word });
      assert(JSON.stringify(all).includes(id), `searchThreads: ${JSON.stringify(all).slice(0, 300)}`);
      const none = await s.cb.ok("orchestration.searchThreads", { query: `nothing${ctx.run}` });
      assert(!JSON.stringify(none).includes(id), "a query with no match returned the chat");
      const inside = await s.cb.ok("orchestration.searchThread", { threadId: id, query: word });
      const hits = JSON.stringify(inside);
      assert(hits.includes(word) || /"total(Count|Matches)?":\s*[1-9]/.test(hits) || /"matches":\[\{/.test(hits), `searchThread: ${hits.slice(0, 400)}`);
      const streamed = [];
      const stop = s.cb.stream("orchestration.searchThreadStream", { threadId: id, query: word }, (v) => streamed.push(v));
      await waitFor("streamed search results", () => streamed.length > 0, 20_000);
      stop();
      return `Bob found "${word}" across chats (${(all.results ?? all.threads ?? all).length ?? "n"} result(s)), inside the chat and by stream (${streamed.length} frame(s)); a non-matching query found nothing`;
    },
  },
  {
    name: "chat-queue-edit-reorder-cancel-steer",
    capability: "1-chat",
    fn: async (ctx) => {
      const s = await world(ctx);
      const id = await launch(s.ca, s.projectId, "Long answer [[fake:long 500]] [[fake:delay 40]]", "Queue");
      const a = watchThread(s.ca, id);
      const b = watchThread(s.cb, id);
      const active = await waitFor("run running", () => [...a.runs.values()].find((r) => r.status === "running"), 60_000);
      await waitFor("provider turn streaming", () => a.assistantText().length > 20, 60_000);
      await send(s.cb, id, "queued one [[fake:text one]]");
      await send(s.cb, id, "queued two [[fake:text two]]");
      const queued = await waitFor("two queued runs", () => {
        const q = [...a.runs.values()].filter((r) => r.status === "queued");
        return q.length >= 2 ? q : null;
      }, 20_000);
      const [q1, q2] = queued.sort((x, y) => String(x.queueOrderKey ?? x.ordinal ?? x.createdAt).localeCompare(String(y.queueOrderKey ?? y.ordinal ?? y.createdAt)));
      // Alice edits the second, moves it before the first, cancels the first, then steers the active run with it.
      await dispatch(s.ca, { type: "queued-run.edit", threadId: id, runId: q2.id, text: `edited two ${ctx.run}` });
      await waitFor("Bob sees the edit", () => b.userMessages().some((m) => m.text === `edited two ${ctx.run}`), 20_000);
      await dispatch(s.ca, { type: "queued-run.reorder", threadId: id, runId: q2.id, beforeRunId: q1.id });
      await dispatch(s.ca, { type: "queued-run.cancel", threadId: id, runId: q1.id });
      await waitFor("Bob sees the cancel", () => b.runs.get(q1.id)?.status === "cancelled", 20_000);
      await dispatch(s.ca, { type: "queued-message.promote-to-steer", threadId: id, queuedRunId: q2.id, targetRunId: active.id });
      await waitFor("thread settled", () => a.settled() && b.settled(), 120_000);
      const steered = (await fakeRequests()).some((r) => JSON.stringify(r.messages).includes(`edited two ${ctx.run}`));
      const finalQ2 = a.runs.get(q2.id)?.status;
      a.stop();
      b.stop();
      // A command retried with the same id does not duplicate the message.
      const commandId = crypto.randomUUID();
      const messageId = `message:wpf:${crypto.randomUUID()}`;
      const cmd = { type: "message.dispatch", commandId, createdBy: "user", creationSource: "web", threadId: id, messageId, text: `retry once ${ctx.run} [[fake:text ok]]`, attachments: [], dispatchMode: { type: "queue_after_active" } };
      await s.ca.call("orchestration.dispatchCommand", cmd);
      await s.ca.call("orchestration.dispatchCommand", cmd);
      await waitFor("retried message projected", async () => (await projection(s.cb, id)).messages.some((m) => m.text === `retry once ${ctx.run} [[fake:text ok]]`), 20_000);
      const msgs = (await projection(s.cb, id)).messages.filter((m) => m.text === `retry once ${ctx.run} [[fake:text ok]]`);
      assert(msgs.length === 1, `a retried command created ${msgs.length} messages`);
      assert(steered, "the steered text never reached the model");
      return `queue of 2 (Bob) → edit, reorder, cancel (Alice) seen live by Bob; promote-to-steer reached the model mid-run (queued run now ${finalQ2}); a retried dispatch (same command id) made 1 message`;
    },
  },
  {
    name: "chat-inbox-state",
    capability: "1-chat",
    fn: async (ctx) => {
      const s = await world(ctx);
      const shellB = watchShell(s.cb);
      const ids = [];
      for (const n of [1, 2]) {
        const id = await launch(s.ca, s.projectId, `inbox ${n} [[fake:text ok]]`, `Inbox ${n}`);
        const t = watchThread(s.ca, id);
        await waitFor("turn completed", () => t.settled(), 60_000);
        t.stop();
        ids.push(id);
      }
      const seen = (id, pred, what) => waitFor(`Bob sees ${what}`, () => {
        const t = shellB.threads.get(id);
        return t && pred(t) ? t : null;
      }, 20_000).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify(shellB.threads.get(id))?.slice(0, 600)}`); });
      await dispatch(s.ca, { type: "thread.pin", threadId: ids[0], orderKey: "a1" });
      await dispatch(s.ca, { type: "thread.pin", threadId: ids[1], orderKey: "a2" });
      await seen(ids[1], (t) => t.pinnedAt, "pin");
      await dispatch(s.ca, { type: "thread.pin.reorder", threadId: ids[1], orderKey: "a0" });
      const reordered = await seen(ids[1], (t) => t.pinOrderKey === "a0", "pin reorder");
      const isUnread = (t) => t.latestRunCompletedAt && (!t.lastVisitedAt || Date.parse(t.lastVisitedAt) < Date.parse(t.latestRunCompletedAt));
      await dispatch(s.cb, { type: "thread.visit", threadId: ids[0], visitedAt: new Date().toISOString() });
      await seen(ids[0], (t) => !isUnread(t), "read");
      await dispatch(s.ca, { type: "thread.mark-unread", threadId: ids[0] });
      const unread = await seen(ids[0], isUnread, "unread");
      await dispatch(s.cb, { type: "thread.visit", threadId: ids[0], visitedAt: new Date().toISOString() });
      await seen(ids[0], (t) => !isUnread(t), "read again");
      const until = new Date(Date.now() + 3_600_000).toISOString();
      await dispatch(s.ca, { type: "thread.snooze", threadId: ids[1], snoozedUntil: until });
      await seen(ids[1], (t) => t.snoozedUntil, "snooze");
      await dispatch(s.ca, { type: "thread.unsnooze", threadId: ids[1], reason: "user" });
      await seen(ids[1], (t) => t.snoozedUntil === null, "unsnooze");
      shellB.stop();
      ctx.state.inboxThreads = ids;
      return `pin ×2 + reorder (key ${reordered.pinOrderKey}), read (Bob's visit) → unread (Alice: lastVisitedAt ${unread.lastVisitedAt?.slice(11, 23)} < last answer ${unread.latestRunCompletedAt?.slice(11, 23)}) → read, snooze/unsnooze: all seen live on Bob's connection`;
    },
  },
  {
    name: "chat-snooze-returns-without-client",
    capability: "1-chat",
    fn: async (ctx) => {
      const s = await world(ctx);
      const id = await launch(s.ca, s.projectId, "snooze me [[fake:text ok]]", "Snoozed");
      const t = watchThread(s.ca, id);
      await waitFor("turn", () => t.settled(), 60_000);
      t.stop();
      await dispatch(s.ca, { type: "thread.visit", threadId: id, visitedAt: new Date().toISOString() });
      const until = new Date(Date.now() + 45_000).toISOString();
      await dispatch(s.ca, { type: "thread.snooze", threadId: id, snoozedUntil: until });
      await idleSpace(s.team);
      disconnect(ctx);
      // Put the space to sleep (admin stop disposes T3): only the SpaceCell's alarm can bring the chat back.
      const a = await adminSession();
      const t0 = Date.now();
      const stop = await a.http("POST", `/api/baskule/admin/spaces/${s.team}/stop`, {});
      if (!stop.ok) {
        await reconnect(ctx);
        throw new Error(`admin stop: ${stop.status} ${await stop.text()} after ${Date.now() - t0} ms`);
      }
      const asleep = await waitFor("space asleep", async () => ((await spaceStatus(s.team)).status?.awake === false ? true : null), 30_000, 1000);
      log(`  space asleep (${asleep}); snooze due at ${until}`);
      const woke = await waitFor("space woken by its alarm", async () => ((await spaceStatus(s.team)).status?.awake === true ? Date.now() : null), 120_000, 2000);
      await reconnect(ctx);
      const shell = watchShell(s.ca);
      const back = await waitFor("chat back in the inbox", () => {
        const x = shell.threads.get(id);
        return x && x.snoozedUntil === null && Date.parse(x.lastVisitedAt) < Date.parse(x.latestRunCompletedAt) ? x : null;
      }, 30_000).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify(shell.threads.get(id), ["snoozedUntil", "lastSnoozeWakeAt", "lastVisitedAt", "latestRunCompletedAt"])}`); });
      shell.stop();
      const lag = Math.round((woke - Date.parse(until)) / 1000);
      return `snoozed until ${until.slice(11, 19)}Z, all clients gone and the space asleep; the alarm woke the space ${lag >= 0 ? `${lag} s after` : `${-lag} s before`} due; the chat came back (snoozedUntil null, unread: ${Date.parse(back.lastVisitedAt) < Date.parse(back.latestRunCompletedAt) ? "yes" : "no"})`;
    },
  },
  {
    name: "chat-question-two-devices",
    capability: "1-chat",
    fn: async (ctx) => {
      const s = await world(ctx);
      const q = (text) => JSON.stringify({ questions: [{ question: text, header: "Pick", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cold" }] }] });
      const id = await launch(s.ca, s.projectId, `Ask [[fake:tool question ${q("Pick a color")}]]`, "Questions");
      const a = watchThread(s.ca, id);
      const b = watchThread(s.cb, id);
      const req = await requestOf(s.cb, id, "user_input");
      // Alice answers on her device; Bob's device shows it resolved, and the model gets the answer.
      await dispatch(s.ca, { type: "runtime-request.respond", threadId: id, requestId: req.id, answers: { q0: "Blue" } });
      await waitFor("Bob sees it answered", () => b.requests.get(req.id)?.status && b.requests.get(req.id).status !== "pending", 30_000);
      await waitFor("model got the answer", () => a.assistantText().includes("Blue"), 60_000);
      const answered = await resolved(s.cb, id, req.id);
      // A second question, dismissed by Bob.
      await send(s.ca, id, `Again [[fake:tool question ${q("Pick another")}]]`);
      const req2 = await waitFor("second question", async () => {
        const p = await projection(s.ca, id);
        return pending(p).find((r) => r.kind === "user_input" && r.id !== req.id) ?? null;
      }, 60_000, 500);
      await dispatch(s.cb, { type: "thread.user-input.dismiss", threadId: id, requestId: req2.id });
      await waitFor("Alice sees it dismissed", () => a.requests.get(req2.id)?.status && a.requests.get(req2.id).status !== "pending", 30_000);
      await waitFor("thread settled", () => a.settled(), 60_000);
      const dismissed = await resolved(s.ca, id, req2.id);
      a.stop();
      b.stop();
      return `question answered by Alice → Bob saw "${answered.status}", the model got "Blue"; second question dismissed by Bob → Alice saw "${dismissed.status}"`;
    },
  },
  {
    name: "chat-approval-two-devices",
    capability: "1-chat",
    fn: async (ctx) => {
      const s = await world(ctx);
      const args = (word) => JSON.stringify({ command: `echo ${word}`, description: "print a word" });
      const id = await launch(s.ca, s.projectId, `Run [[fake:tool shell ${args(`approved-${ctx.run}`)}]]`, "Approvals", { runtimeMode: "approval-required" });
      const a = watchThread(s.ca, id);
      const b = watchThread(s.cb, id);
      const req = await requestOf(s.ca, id, "approval");
      await dispatch(s.cb, { type: "runtime-request.respond", threadId: id, requestId: req.id, decision: "accept" });
      await waitFor("Alice sees it approved", () => a.requests.get(req.id)?.status && a.requests.get(req.id).status !== "pending", 30_000);
      await waitFor("command ran", () => a.assistantText().includes(`approved-${ctx.run}`), 90_000);
      await send(s.ca, id, `Run again [[fake:tool shell ${args(`declined-${ctx.run}`)}]]`);
      const req2 = await waitFor("second approval", async () => {
        const p = await projection(s.ca, id);
        return pending(p).find((r) => r.kind !== "user_input" && r.id !== req.id) ?? null;
      }, 60_000, 500);
      await dispatch(s.ca, { type: "runtime-request.respond", threadId: id, requestId: req2.id, decision: "decline" });
      await waitFor("Bob sees it declined", () => b.requests.get(req2.id)?.status && b.requests.get(req2.id).status !== "pending", 30_000);
      await waitFor("settled", () => a.settled(), 90_000);
      const last = a.assistantText();
      a.stop();
      b.stop();
      assert(!/declined-[a-z0-9]+\n/.test(last.split("Run again").pop() ?? ""), "the declined command seems to have run");
      return `approval (kind ${req.kind}) accepted by Bob → ran on the computer, Alice saw it resolved; second approval declined by Alice → Bob saw it resolved, command not run`;
    },
  },
  {
    name: "chat-long-history-paging",
    capability: "1-chat",
    fn: async (ctx) => {
      const s = await world(ctx);
      const first = `first-${ctx.run}`;
      const id = await launch(s.ca, s.projectId, `${first} [[fake:text one]]`, "Long history");
      const t = watchThread(s.ca, id);
      await waitFor("first turn", () => t.settled(), 60_000);
      for (let i = 2; i <= 26; i++) await send(s.ca, id, `turn ${i} [[fake:text answer ${i}]]`);
      await waitFor("26 turns", () => [...t.runs.values()].filter((r) => r.status === "completed").length >= 26, 300_000, 500);
      t.stop();
      const get = async (path) => {
        const r = await s.bob.http("GET", `/s/${s.team}${path}`, undefined, { "x-t3-orchestration-protocol": "2" });
        assert(r.ok, `GET ${path}: ${r.status} ${await r.clone().text()}`);
        return r.json();
      };
      const enc = encodeURIComponent(id);
      const bounded = await get(`/api/orchestration/threads/${enc}/bounded`);
      const text = JSON.stringify({ messages: bounded.projection?.messages, turnItems: bounded.projection?.turnItems });
      assert(!text.includes(first), "the bounded snapshot already holds the first message (raise the turn count)");
      let cursor = bounded.historyCursor ?? bounded.projection?.historyCursor;
      assert(cursor, `no history cursor: ${Object.keys(bounded)}`);
      let pages = 0;
      let found = false;
      while (cursor && pages < 10 && !found) {
        const page = await get(`/api/orchestration/threads/${enc}/history?cursor=${encodeURIComponent(cursor)}`);
        pages++;
        found = JSON.stringify(page).includes(first);
        cursor = page.nextCursor ?? page.historyCursor ?? null;
      }
      assert(found, `the first message was not reached after ${pages} page(s)`);
      return `26 turns; Bob's bounded snapshot (HTTP, through the Worker) omits the oldest; ${pages} older-history page(s) reached the first message`;
    },
  },
  {
    name: "chat-failure-rendered",
    capability: "1-chat",
    fn: async (ctx) => {
      const s = await world(ctx);
      // A non-retryable provider error: a 5xx is retried with backoff for ~80 s before the same failed status.
      const id = await launch(s.ca, s.projectId, "This fails [[fake:error 400]]", "Failure");
      const b = watchThread(s.cb, id);
      const run = await waitFor("run failed", () => [...b.runs.values()].find((r) => r.status === "failed"), 120_000).catch((e) => {
        throw new Error(`${e.message}: ${JSON.stringify([...b.runs.values()].map((r) => r.status))}`);
      });
      const p = await projection(s.cb, id);
      const items = (p.turnItems ?? []).filter((i) => /error|fail/i.test(`${i.type} ${i.status} ${i.title}`));
      const reason = run.failure?.message ?? run.error?.message ?? run.failureMessage ?? items[0]?.title ?? JSON.stringify(run).match(/"message":"([^"]{0,200})/)?.[1];
      b.stop();
      assert(reason, `failed run carries no message: ${JSON.stringify(run).slice(0, 600)}`);
      return `the model's HTTP 400 → run "failed" on Bob's connection with message "${String(reason).slice(0, 160)}"`;
    },
  },
];
