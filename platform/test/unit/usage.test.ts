import { describe, expect, it, vi } from "vitest";
import { makeService, call } from "../support/harness";
import { limitStatuses, rawUsageCutoff, totalTokens, usageCost, usageWindow } from "../../src/control/usage-windows";
import type { UsageRecord } from "../../../app/packages/contracts/src/baskule-usage";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
export const record = (spaceId: string, extra: Partial<UsageRecord> = {}): UsageRecord => {
  const r: UsageRecord = { spaceId, messageId: "assistant-1", turnId: "turn-1", chatId: "chat-1", userId: "anonymous", provider: "mistral", model: "test", occurredAt: new Date(NOW).toISOString(),
    tokens: { input: 10, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5 }, prices: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 3 }, costUsd: 0, ...extra };
  r.costUsd = usageCost(r.tokens, r.prices);
  return r;
};
const setup = () => makeService({ AUTH_CONFIG: '{"mode":"anonymous"}' });

describe("UTC usage windows", () => {
  it.each([
    ["daily", "2026-10-25T00:00:00.000Z", "2026-10-26T00:00:00.000Z"],
    ["weekly", "2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z"],
    ["monthly", "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
  ] as const)("%s uses calendar boundaries", (window, start, end) => {
    expect(usageWindow(window, NOW)).toEqual({ start: Date.parse(start), end: Date.parse(end) });
    expect(usageWindow(window, Date.parse(end)).start).toBe(Date.parse(end));
  });
  it("handles Monday at year rollover and leap-year February", () => {
    expect(new Date(usageWindow("weekly", Date.parse("2025-01-01T01:00Z")).start).toISOString()).toBe("2024-12-30T00:00:00.000Z");
    expect(new Date(usageWindow("monthly", Date.parse("2024-02-29T22:00Z")).end).toISOString()).toBe("2024-03-01T00:00:00.000Z");
    expect(new Date(rawUsageCutoff(Date.parse("2025-03-31T10:00Z"))).toISOString()).toBe("2024-02-29T10:00:00.000Z");
  });
  it("uses >=, either budget, zero budgets and no limits when disabled", () => {
    const settings = { enabled: true, rules: [{ window: "daily" as const, tokens: 10 }, { window: "weekly" as const, costUsd: 1 }, { window: "monthly" as const, tokens: 0, costUsd: 100 }] };
    expect(limitStatuses(settings, () => ({ tokens: 10, costUsd: 0.5 }), NOW).map(s => s.blocked)).toEqual([true, false, true]);
    expect(limitStatuses({ ...settings, enabled: false }, () => ({ tokens: 999, costUsd: 999 }), NOW)).toEqual([]);
  });
});

describe("ControlCell usage", () => {
  it("ingests idempotently, snapshots prices, counts distinct chats and turns, and isolates user totals", async () => {
    using _clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const h = await setup();
    const me = await call(h, "GET", "/api/baskule/me");
    const spaceId = me.body.spaces[0].id;
    const a = record(spaceId), b = record(spaceId, { messageId: "assistant-tool-2" });
    const ingest = (records: UsageRecord[]) => h.svc.usage.ingest({ spaceId, records }, NOW);
    ingest([a, b]); ingest([b, a]);
    ingest([record(spaceId, { messageId: "b", turnId: "turn-2" }), record(spaceId, { userId: "bob", messageId: "c", turnId: "turn-3", chatId: "chat-2" })]);
    const mine = h.svc.usage.me("anonymous", NOW);
    expect(mine.limits).toEqual([]);
    expect(mine.daily).toHaveLength(90);
    expect(mine.totals.today.tokens).toBe(totalTokens(a.tokens) * 3);
    expect(mine.totals.today.costUsd).toBeCloseTo(a.costUsd * 3);
    const admin = h.svc.usage.admin(new URL("http://control/?from=2026-10-25&to=2026-10-25"), NOW);
    expect(admin.totals).toMatchObject({ turns: 3, chats: 2, activeUsers: 2 });
    expect(admin.byUser.find(u => u.userId === "anonymous")).toMatchObject({ turns: 2, chats: 1 });
    expect(JSON.parse(String(h.storage.sql.exec("select record from usage_record where message_id=?", a.messageId).toArray()[0].record))).toEqual(a);
    expect(() => ingest([{ ...a, messageId: "bad", costUsd: 42 }])).toThrow(/invalid_usage_cost/);
    expect(() => ingest([{ ...a, spaceId: "other" }])).toThrow();
  });
  it("prunes raw records at 13 calendar months, retaining rollups and ignoring expired retries", async () => {
    const h = await setup();
    const spaceId = h.storage.sql.exec("select id from space").toArray()[0].id as string;
    const old = record(spaceId, { occurredAt: "2025-09-25T11:59:59.999Z" });
    const edge = record(spaceId, { messageId: "edge", occurredAt: "2025-09-25T12:00:00.000Z" });
    h.svc.usage.ingest({ spaceId, records: [old, edge] }, Date.parse(edge.occurredAt));
    h.svc.usage.prune(NOW);
    expect(h.storage.sql.exec("select message_id from usage_record").toArray()).toEqual([{ message_id: "edge" }]);
    h.svc.usage.ingest({ spaceId, records: [old, edge] }, NOW);
    expect(h.storage.sql.exec("select sum(tokens) as n from usage_daily").toArray()[0].n).toBe(totalTokens(old.tokens) * 2);
    expect(h.storage.sql.exec("select count(*) as n from usage_turn").toArray()[0].n).toBe(1);
  });
  it("validates settings, reports reset times, rejects public ingestion and restricts API access", async () => {
    using _clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const h = await setup();
    const spaceId = h.storage.sql.exec("select id from space").toArray()[0].id as string;
    const settings = { enabled: true, rules: [{ window: "daily", tokens: 42 }, { window: "monthly", costUsd: 1 }] };
    expect((await call(h, "PUT", "/api/baskule/admin/usage/limits", { body: settings })).body).toEqual(settings);
    expect(h.calls.at(-1)?.path).toBe("/_baskule/usage-limits-changed");
    h.svc.usage.ingest({ spaceId, records: [record(spaceId)] }, NOW);
    expect((await call(h, "GET", "/api/baskule/usage/me")).body.limits[0]).toMatchObject({ blocked: true, resetsAt: "2026-10-26T00:00:00.000Z" });
    expect((await call(h, "GET", "/api/baskule/admin/usage/limits")).body).toEqual(settings);
    for (const rules of [[{ window: "daily" }], [{ window: "daily", tokens: -1 }], [{ window: "daily", tokens: 1 }, { window: "daily", tokens: 2 }]])
      expect((await call(h, "PUT", "/api/baskule/admin/usage/limits", { body: { enabled: true, rules } })).status).toBe(400);
    expect((await call(h, "POST", "/_baskule/usage", { body: { spaceId, records: [] } })).status).toBe(404);
    expect((await call(h, "GET", "/api/baskule/admin/usage?from=bad")).status).toBe(400);
    const authenticated = await makeService();
    expect((await call(authenticated, "GET", "/api/baskule/usage/me")).status).toBe(401);
    expect((await call(authenticated, "GET", "/api/baskule/admin/usage")).status).toBe(401);
  });
});
