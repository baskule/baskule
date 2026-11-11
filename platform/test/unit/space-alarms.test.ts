import { expect, it } from "vitest";
import { agentAlarmNeedsRuntime, SpaceAlarms } from "../../src/space/alarms";
import { fakeStorage } from "../support/fake-storage";

function storage() {
  const keys = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    get: async (key: string) => keys.get(key), put: async (key: string, v: unknown) => { keys.set(key, v); },
    delete: async (key: string) => keys.delete(key),
    getAlarm: async () => alarm, setAlarm: async (t: number) => { alarm = t; }, deleteAlarm: async () => { alarm = null; },
  } as unknown as DurableObjectStorage;
}

it("agent alarm cancellation preserves the space deadline and vice versa", async () => {
  const s = storage(), a = new SpaceAlarms(s), now = Date.now();
  await a.set("space", now + 60000); await a.set("agent", now + 5000);
  expect(await s.getAlarm()).toBe(now + 5000);
  await a.forAgent().deleteAlarm(); expect(await s.getAlarm()).toBe(now + 60000);
  await a.set("agent", now + 5000); await a.clear("space"); expect(await s.getAlarm()).toBe(now + 5000);
  await a.clear("agent"); expect(await s.getAlarm()).toBeNull();
});

it("a claimed agent alarm survives process loss before its handler completes", async () => {
  const s = storage(), first = new SpaceAlarms(s);
  await first.set("agent", Date.now());
  expect(await first.due()).toContain("agent");
  expect(await first.get("agent")).toBeNull();
  const restarted = new SpaceAlarms(s);
  expect(await restarted.due()).toContain("agent");
  await restarted.sync();
  expect(await s.getAlarm()).not.toBeNull();
  await restarted.complete(["agent"]);
  expect(await restarted.due()).toEqual([]);
  expect(await s.getAlarm()).toBeNull();
});

it("loads a cold agent only for recovery, unreported usage or an unacknowledged receipt", async () => {
  const s = storage();
  const sql = fakeStorage();
  const state = { get: s.get.bind(s), sql: sql.sql } as Pick<DurableObjectStorage, "get" | "sql">;
  try {
    expect(await agentAlarmNeedsRuntime(state)).toBe(false);
    await s.put("baskule:busy", true);
    expect(await agentAlarmNeedsRuntime(state)).toBe(true);
    await s.delete("baskule:busy");
    sql.db.exec(`create table baskule_usage_outbox(message_id text primary key, record text);
      create table baskule_usage_context(prompt_id text);
      create table session_message(id text, type text, data text);`);
    expect(await agentAlarmNeedsRuntime(state)).toBe(false);
    sql.db.exec(`insert into baskule_usage_outbox values('pending','{}')`);
    expect(await agentAlarmNeedsRuntime(state)).toBe(true);
    sql.db.exec(`update baskule_usage_outbox set record=null`);
    expect(await agentAlarmNeedsRuntime(state)).toBe(false);
    sql.db.exec(`insert into baskule_usage_context values('prompt');
      insert into session_message values('unfinished','assistant','{"time":{},"tokens":{}}');
      insert into session_message values('user','user','{"time":{"completed":1},"tokens":{}}');`);
    expect(await agentAlarmNeedsRuntime(state)).toBe(false);
    sql.db.exec(`insert into session_message values('completed','assistant','{"time":{"completed":1},"tokens":{}}')`);
    expect(await agentAlarmNeedsRuntime(state)).toBe(true);
    sql.db.exec(`insert into baskule_usage_outbox values('completed',null)`);
    expect(await agentAlarmNeedsRuntime(state)).toBe(false);
  } finally { sql.db.close(); }
});
