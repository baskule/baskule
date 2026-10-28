import { z } from "zod";
import type { AdminUsage, MyUsage, UsageAmount, UsageDaily, UsageLimitSettings, UsageWindow } from "../../../app/packages/contracts/src/baskule-usage";
import type { SpaceCaller, StorageLike } from "./service";
import { HttpError, json, notFound, readJson } from "../shared/http";
import { DAY, dateKey, limitStatuses, rawUsageCutoff, totalTokens, usageCost, usageWindow } from "./usage-windows";

const nonnegative = z.number().finite().min(0);
const id = z.string().min(1).max(500);
const recordSchema = z.object({
  messageId: id, turnId: id, userId: id, spaceId: id, chatId: id, provider: id, model: id,
  occurredAt: z.iso.datetime(),
  tokens: z.object({ input: nonnegative, output: nonnegative, reasoning: nonnegative, cacheRead: nonnegative, cacheWrite: nonnegative }).strict(),
  prices: z.object({ input: nonnegative, output: nonnegative, cacheRead: nonnegative.optional(), cacheWrite: nonnegative.optional() }).strict(),
  costUsd: nonnegative,
}).strict();
const settingsSchema = z.object({ enabled: z.boolean(), rules: z.array(z.object({
  window: z.enum(["daily", "weekly", "monthly"]), tokens: nonnegative.int().optional(), costUsd: nonnegative.optional(),
}).strict().refine(r => r.tokens !== undefined || r.costUsd !== undefined, "A rule needs a token or cost limit")).max(3) }).strict()
  .refine(s => new Set(s.rules.map(r => r.window)).size === s.rules.length, "One rule per window");
const batchSchema = z.object({ spaceId: id, records: z.array(recordSchema).max(100) }).strict();
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "invalid_usage", result.error.issues.map(i => i.message).join("; "));
  return result.data;
};
const sums = "coalesce(sum(tokens),0) as tokens, coalesce(sum(cost_usd),0) as costUsd";

export class UsageService {
  private prunedAt = 0;
  constructor(private storage: StorageLike, private callSpace: SpaceCaller) {}
  private all(q: string, ...p: unknown[]) { return this.storage.sql.exec(q, ...p).toArray(); }
  settings(): UsageLimitSettings {
    const row = this.all("select value from kv where key='usage_limits'")[0];
    return row ? parse(settingsSchema, JSON.parse(String(row.value))) : { enabled: false, rules: [] };
  }
  prune(now = Date.now()) {
    if (now - this.prunedAt < DAY) return;
    this.all("delete from usage_record where occurred_at < ?", rawUsageCutoff(now));
    this.prunedAt = now;
  }
  ingest(input: unknown, now = Date.now()) {
    const { spaceId, records } = parse(batchSchema, input);
    if (!this.all("select 1 from space where id=?", spaceId).length) throw new HttpError(404, "space_not_found");
    for (const r of records) {
      if (r.spaceId !== spaceId || Date.parse(r.occurredAt) > now + 60_000) throw new HttpError(400, "invalid_usage");
      if (Math.abs(r.costUsd - usageCost(r.tokens, r.prices)) > 1e-9) throw new HttpError(400, "invalid_usage_cost");
    }
    this.storage.transactionSync(() => {
      this.prune(now);
      for (const r of records) {
        // An expired retry must not resurrect a raw record and count it again after pruning.
        if (Date.parse(r.occurredAt) < rawUsageCutoff(now)) continue;
        const inserted = this.all("insert into usage_record(space_id,message_id,occurred_at,record) values(?,?,?,?) on conflict do nothing returning message_id",
          spaceId, r.messageId, Date.parse(r.occurredAt), JSON.stringify(r));
        if (!inserted.length) continue;
        const date = dateKey(Date.parse(r.occurredAt));
        const turn = this.all("insert into usage_turn(space_id,turn_id,user_id,chat_id,date) values(?,?,?,?,?) on conflict do nothing returning turn_id",
          spaceId, r.turnId, r.userId, r.chatId, date);
        this.all(`insert into usage_daily(date,user_id,provider,model,space_id,tokens,cost_usd,turns) values(?,?,?,?,?,?,?,?)
          on conflict(date,user_id,provider,model,space_id) do update set tokens=tokens+excluded.tokens, cost_usd=cost_usd+excluded.cost_usd, turns=turns+excluded.turns`,
          date, r.userId, r.provider, r.model, spaceId, totalTokens(r.tokens), r.costUsd, turn.length);
      }
    });
    return { accepted: records.map(r => r.messageId) };
  }
  private amount(userId: string, window: UsageWindow, now: number): UsageAmount {
    const { start, end } = usageWindow(window, now);
    return this.all(`select ${sums} from usage_daily where user_id=? and date>=? and date<?`, userId, dateKey(start), dateKey(end))[0] as unknown as UsageAmount;
  }
  limits(userId: string, now = Date.now()) { return limitStatuses(this.settings(), w => this.amount(userId, w, now), now); }
  private daily(where: string, params: unknown[], from: string, to: string): UsageDaily[] {
    const rows = this.all(`select date, ${sums}, sum(turns) as turns from usage_daily where ${where} group by date order by date`, ...params);
    const series = new Map(rows.map(r => [String(r.date), r]));
    const result: UsageDaily[] = [];
    for (let at = Date.parse(from); at <= Date.parse(to); at += DAY) {
      const date = dateKey(at);
      result.push((series.get(date) ?? { date, tokens: 0, costUsd: 0, turns: 0 }) as unknown as UsageDaily);
    }
    return result;
  }
  me(userId: string, now = Date.now()): MyUsage {
    const from = dateKey(now - 89 * DAY), to = dateKey(now);
    return {
      limits: this.limits(userId, now),
      totals: { today: this.amount(userId, "daily", now), week: this.amount(userId, "weekly", now), month: this.amount(userId, "monthly", now) },
      daily: this.daily("user_id=? and date between ? and ?", [userId, from, to], from, to),
      byModel: this.all(`select provider, model, ${sums} from usage_daily where user_id=? and date between ? and ? group by provider,model order by tokens desc`, userId, from, to) as unknown as MyUsage["byModel"],
    };
  }
  admin(url: URL, now = Date.now()): AdminUsage {
    const from = url.searchParams.get("from") ?? dateKey(now - 89 * DAY), to = url.searchParams.get("to") ?? dateKey(now);
    const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && dateKey(Date.parse(s)) === s;
    if (!validDate(from) || !validDate(to) || from > to || Date.parse(to) - Date.parse(from) > 3660 * DAY) throw new HttpError(400, "invalid_usage_range", "Use inclusive UTC dates (YYYY-MM-DD), at most ten years apart.");
    const counts = (column?: "user_id" | "space_id") => this.all(`select ${column ? `${column} as id,` : ""} count(*) as turns, count(distinct json_array(space_id,chat_id)) as chats from usage_turn where date between ? and ? ${column ? `group by ${column}` : ""}`, from, to);
    const totals = this.all(`select ${sums}, count(distinct user_id) as activeUsers from usage_daily where date between ? and ?`, from, to)[0];
    const userCounts = new Map(counts("user_id").map(r => [r.id, r]));
    const spaceCounts = new Map(counts("space_id").map(r => [r.id, r]));
    const grouped = (column: "user_id" | "space_id") => this.all(`select ${column} as id, ${sums} from usage_daily where date between ? and ? group by ${column} order by tokens desc`, from, to);
    return {
      from, to, totals: { ...totals, ...counts()[0] } as unknown as AdminUsage["totals"],
      byUser: grouped("user_id").map(({ id, ...r }) => ({ ...r, userId: id, turns: userCounts.get(id)?.turns ?? 0, chats: userCounts.get(id)?.chats ?? 0,
        ...(this.all("select name,email from user where id=?", id)[0] ?? { name: null, email: null }) })) as AdminUsage["byUser"],
      bySpace: grouped("space_id").map(({ id, ...r }) => ({ ...r, spaceId: id, turns: spaceCounts.get(id)?.turns ?? 0, chats: spaceCounts.get(id)?.chats ?? 0,
        name: this.all("select name from space where id=?", id)[0]?.name ?? null })) as AdminUsage["bySpace"],
      byModel: this.all(`select provider,model,${sums},sum(turns) as turns from usage_daily where date between ? and ? group by provider,model order by tokens desc`, from, to) as unknown as AdminUsage["byModel"],
      daily: this.daily("date between ? and ?", [from, to], from, to),
    };
  }
  async privateRoute(req: Request): Promise<Response> {
    if (req.method !== "POST") return notFound();
    if (new URL(req.url).pathname === "/_baskule/usage") return json(this.ingest(await readJson(req)));
    const input = parse(z.object({ spaceId: id, userId: id, records: z.array(recordSchema).max(100).default([]) }).strict(), await readJson(req));
    const accepted = this.ingest({ spaceId: input.spaceId, records: input.records });
    return json({ ...accepted, settings: this.settings(), limits: this.limits(input.userId) });
  }
  async adminRoute(req: Request, path: string, url: URL): Promise<Response> {
    if (path === "/usage" && req.method === "GET") return json(this.admin(url));
    if (path !== "/usage/limits") return notFound();
    if (req.method === "GET") return json(this.settings());
    if (req.method !== "PUT") return notFound();
    const settings = parse(settingsSchema, await readJson(req));
    this.all("insert into kv(key,value) values('usage_limits',?) on conflict(key) do update set value=excluded.value", JSON.stringify(settings));
    await Promise.all(this.all("select id from space").map(async ({ id }) => {
      try {
        const res = await this.callSpace(String(id), "/_baskule/usage-limits-changed", { method: "POST", body: JSON.stringify(settings), signal: AbortSignal.timeout(3_000) });
        await res.body?.cancel();
      } catch { console.warn(`Usage limits saved; space ${id} will refresh within its cache TTL`); }
    }));
    return json(settings);
  }
}
