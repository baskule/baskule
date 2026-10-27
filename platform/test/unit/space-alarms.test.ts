import { expect, it } from "vitest";
import { SpaceAlarms } from "../../src/space/alarms";

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
