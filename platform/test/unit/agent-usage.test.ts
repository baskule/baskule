import { fakeStorage } from "../support/fake-storage";
import { make as makeSqlClient } from "../../../app/apps/server/src/baskule/workerd/doSqlClient";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";
import { UsageReporter } from "../../src/agent/usage";
import { configPrices, opencodeConfig } from "../../src/agent/config";
import type { ModelRef } from "../../src/agent/session";
import { defaultSettings, parseSettings } from "../../src/control/settings";
import { BASKULE_AI_PROVIDERS } from "../../../app/packages/contracts/src/baskule";
import type { UsageRecord } from "../../../app/packages/contracts/src/baskule-usage";

async function setup() {
  const storage = fakeStorage();
  const db = storage.db;
  const exec = (query: string, params: (string | number | null)[] = []) => {
    const stmt = db.prepare(query);
    return stmt.columns().length ? stmt.all(...params) : (stmt.run(...params), []);
  };
  db.exec(`create table orchestration_v2_projection_runs(run_id text primary key,thread_id text,ordinal integer,status text,payload_json text);
    create table orchestration_v2_projection_run_attempts(attempt_id text,run_id text);
    create table orchestration_v2_projection_messages(message_id text,payload_json text);
    create table orchestration_v2_projection_provider_threads(thread_id text,payload_json text);
    create table session_message(id text primary key,session_id text,type text,seq integer,time_created integer,data text);
    create table session_v2(id text,parent_id text);
    insert into orchestration_v2_projection_runs values('run','chat',1,'running','{"userMessageId":"original"}');
    insert into orchestration_v2_projection_run_attempts values('attempt','run');
    insert into orchestration_v2_projection_messages values('original','{"author":{"id":"alice"}}');
    insert into orchestration_v2_projection_messages values('later','{"author":{"id":"bob"}}');
    insert into orchestration_v2_projection_provider_threads values('chat','{"nativeThreadRef":{"nativeId":"session"}}');
    insert into session_v2 values('session',null);`);
  // The production bundle exposes this client as unknown across the T3/platform Effect boundary.
  const shared = makeSqlClient({ ...storage, transaction: <T>(fn: () => Promise<T>) => fn() } as never);
  const { client: sql } = await Effect.runPromise(shared as unknown as Effect.Effect<{ client: SqlClient }>);
  const received: UsageRecord[] = [];
  const retry = vi.fn(async () => {});
  const state = { down: false, blocked: false };
  const control = vi.fn(async (path: string, body: unknown) => {
    if (state.down) throw new Error("ControlCell unavailable");
    if (path.endsWith("check")) return Response.json({ settings: { enabled: true, rules: [] }, accepted: (body as { records: UsageRecord[] }).records.map(r => r.messageId), limits: state.blocked ? [{ window: "daily", used: { tokens: 42, costUsd: 0.1 }, limit: { tokens: 42 }, resetsAt: new Date(Date.now() + 86400000).toISOString(), blocked: true }] : [] });
    const records = (body as { records: UsageRecord[] }).records;
    received.push(...records);
    return Response.json({ accepted: records.map(r => r.messageId) });
  });
  const ai = { ...defaultSettings.ai, model: { ...defaultSettings.ai.model, cost: { input: 2, output: 4 } } };
  const reporter = (prices = configPrices(opencodeConfig({ AI: { ...ai, apiKey: "test-key" } }, "runtime-key"))) => new UsageReporter(sql, "space", prices, { enabled: true, rules: [] }, control, retry);
  const assistant = (id: string, seq = 2, sessionId = "session", model: ModelRef = { id: ai.model.id, providerID: ai.providerId }) => exec("insert into session_message values(?,?,?,?,?,?)", [id, sessionId, "assistant", seq, Date.now(), JSON.stringify({ model, time: { created: Date.now(), completed: Date.now() }, tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 3, write: 2 } } })]);
  return { db, exec, reporter, assistant, received, control, state, retry, ai };
}

describe("SpaceCell usage reporter", () => {
  it("prices each assistant by its model and still records free-model tokens", async () => {
    const h = await setup();
    const provider = BASKULE_AI_PROVIDERS.opencode;
    const freeAI = parseSettings({ ...defaultSettings, ai: { providerId: "opencode", baseUrl: provider.baseUrl, model: provider.models[0] } }).ai;
    // Exercise per-message pricing independently of the installation's single-provider configuration.
    const prices = {
      ...configPrices(opencodeConfig({ AI: { ...h.ai, apiKey: "test-key" } }, "runtime-key")),
      ...configPrices(opencodeConfig({ AI: { ...freeAI, apiKey: "public" } }, "runtime-key")),
    };
    const u = h.reporter(prices);
    await u.beforeTurn("session", "msg_t3_turn_session:attempt");
    h.assistant("free-answer", 2, "session", { providerID: "opencode", id: "deepseek-v4.1-flash-free" });
    h.assistant("installation-answer", 3);
    await u.flush();
    expect(h.received).toHaveLength(2);
    expect(h.received[0]).toMatchObject({ messageId: "free-answer", provider: "opencode", model: "deepseek-v4.1-flash-free",
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
      tokens: { input: 10, output: 20, reasoning: 5, cacheRead: 3, cacheWrite: 2 } });
    expect(h.received[1]).toMatchObject({ messageId: "installation-answer", provider: h.ai.providerId, model: h.ai.model.id, prices: { input: 2, output: 4 } });
    expect(h.received[1].costUsd).toBeCloseTo(0.00013);
    h.db.close();
  });
  it("uses the initiating message's author, captures each assistant once, snapshots prices, and retries across restart", async () => {
    const h = await setup();
    const u = h.reporter();
    expect(await u.beforeTurn("session", "msg_t3_turn_session:attempt")).toBeUndefined();
    h.ai.model.cost = { input: 100, output: 200 };
    h.assistant("assistant");
    h.state.down = true;
    expect(await u.flush()).toBe(true);
    expect(h.retry).toHaveBeenCalled();
    h.state.down = false;
    await h.reporter().flush();
    expect(h.received).toHaveLength(1);
    expect(h.received[0]).toMatchObject({ userId: "alice", chatId: "chat", turnId: "run", prices: { input: 2, output: 4 }, tokens: { reasoning: 5, cacheRead: 3 } });
    expect(h.received[0].costUsd).toBeCloseTo(0.00013);
    await u.flush();
    expect(h.received).toHaveLength(1);
    h.db.close();
  });
  it("reuses the original author for steering and attributes native subagent steps to their parent turn", async () => {
    const h = await setup(), u = h.reporter();
    await u.beforeTurn("session", "msg_t3_turn_session:attempt");
    h.exec("insert into session_v2 values('child','session')");
    h.assistant("child-answer", 2, "child");
    await u.beforeTurn("session", "msg_t3_steer_session:later");
    await u.flush();
    expect(h.received).toHaveLength(1);
    expect(h.received[0]).toMatchObject({ userId: "alice", turnId: "run" });
    h.db.close();
  });
  it("blocks before starting, carries the status, invalidates cached answers, and never checks an active run again", async () => {
    const h = await setup(), u = h.reporter();
    h.state.blocked = true;
    const refused = await u.beforeTurn("session", "msg_t3_turn_session:attempt");
    expect(refused?.status).toBe(400);
    expect(await refused?.json()).toMatchObject({ code: "usage_limit_reached", message: expect.stringContaining("resets at"), status: { blocked: true } });
    expect(h.exec("select * from baskule_usage_context")).toHaveLength(0);
    h.state.blocked = false;
    u.invalidate({ enabled: false, rules: [] });
    expect(await u.beforeTurn("session", "msg_t3_turn_session:attempt")).toBeUndefined();
    const calls = h.control.mock.calls.length;
    h.state.blocked = true;
    expect(await u.beforeTurn("session", "msg_t3_steer_session:later")).toBeUndefined();
    expect(h.control).toHaveBeenCalledTimes(calls);
    h.db.close();
  });
  it("does not let an in-flight answer restore a cache invalidated by an admin change", async () => {
    const h = await setup(), u = h.reporter();
    h.control.mockImplementationOnce(async () => {
      h.state.blocked = true;
      u.invalidate({ enabled: true, rules: [{ window: "daily", tokens: 0 }] });
      return Response.json({ settings: { enabled: false, rules: [] }, limits: [], accepted: [] });
    });
    expect(await (await u.beforeTurn("session", "msg_t3_turn_session:attempt"))?.json()).toMatchObject({ code: "usage_limit_reached" });
    h.db.close();
  });
  it("checks command turns while starting and ignores another member's queued run", async () => {
    const h = await setup(), u = h.reporter();
    h.exec("update orchestration_v2_projection_runs set status='starting'");
    h.exec("insert into orchestration_v2_projection_runs values('queued-run','chat',2,'queued','{\"userMessageId\":\"later\"}')");
    await u.beforeTurn("session");
    h.assistant("command-answer");
    await u.flush();
    expect(h.received[0]).toMatchObject({ userId: "alice", turnId: "run" });
    h.db.close();
  });
  it("fails closed when enabled limits cannot be checked, and allows recording to retry when disabled", async () => {
    const h = await setup(), u = h.reporter();
    h.state.down = true;
    expect(await (await u.beforeTurn("session", "msg_t3_turn_session:attempt"))?.json()).toMatchObject({ error: "usage_check_unavailable" });
    u.invalidate({ enabled: false, rules: [] });
    expect(await u.beforeTurn("session", "msg_t3_turn_session:attempt")).toBeUndefined();
    h.db.close();
  });
});
