import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { UsageLimitSettings, UsagePrices, UsageRecord, UsageTokens, UsageWindowStatus } from "../../../app/packages/contracts/src/baskule-usage";
import { usageCost } from "../control/usage-windows";

type Row = Record<string, unknown>;
export interface TurnUsageContext { userId: string; chatId: string; turnId: string; modelPrices: Record<string, UsagePrices> }

/** The run names the original user message, even when a second member steers or queues work. */
export function turnUsageAuthor(message: { author?: { id: string } }): string | undefined { return message.author?.id; }

export class UsageReporter {
  private ready: Promise<void> | undefined;
  private capturing: Promise<void> | undefined;
  private flushing: Promise<boolean> | undefined;
  private cache = new Map<string, { until: number; limits: UsageWindowStatus[] }>();
  private settingsUntil = 0;
  private settingsVersion = 0;
  constructor(private sql: SqlClient, private spaceId: string, private modelPrices: Record<string, UsagePrices>,
    private settings: UsageLimitSettings,
    private control: (path: string, body: unknown) => Promise<Response>,
    private retry: () => Promise<void>) {}
  private all(q: string, ...p: (string | number | null)[]): Promise<readonly Row[]> { return Effect.runPromise(this.sql.unsafe<Row>(q, p)); }
  private init() {
    return this.ready ??= (async () => {
      await this.all(`create table if not exists baskule_usage_context (
        prompt_id text primary key, session_id text not null, min_seq integer not null, started_at integer not null, context text not null)`);
      await this.all("create index if not exists baskule_usage_context_session_idx on baskule_usage_context(session_id,min_seq)");
      // A null payload is a receipt. Keep it while the source message exists so a scan cannot re-enqueue it.
      await this.all("create table if not exists baskule_usage_outbox(message_id text primary key, record text)");
    })();
  }
  invalidate(settings?: UsageLimitSettings) {
    this.settingsVersion++;
    if (settings) this.settings = settings;
    this.settingsUntil = 0;
    this.cache.clear();
  }
  private async author(sessionId: string, promptId?: string): Promise<Omit<TurnUsageContext, "modelPrices"> | undefined> {
    // Direct internal agent harnesses have no T3 runtime. Public clients cannot access these routes.
    if (!(await this.all("select name from sqlite_master where name='orchestration_v2_projection_runs'")).length) return;
    const prefix = `msg_t3_turn_${sessionId}:`;
    const attemptId = promptId?.startsWith(prefix) ? promptId.slice(prefix.length) : undefined;
    const rows = attemptId
      ? await this.all(`select r.thread_id, r.run_id, m.payload_json from orchestration_v2_projection_run_attempts a
          join orchestration_v2_projection_runs r on r.run_id=a.run_id
          join orchestration_v2_projection_messages m on m.message_id=json_extract(r.payload_json,'$.userMessageId') where a.attempt_id=?`, attemptId)
      : await this.all(`select r.thread_id, r.run_id, m.payload_json from orchestration_v2_projection_provider_threads p
          join orchestration_v2_projection_runs r on r.thread_id=p.thread_id
          join orchestration_v2_projection_messages m on m.message_id=json_extract(r.payload_json,'$.userMessageId')
          where json_extract(p.payload_json,'$.nativeThreadRef.nativeId')=? and r.status in ('starting','running','waiting') order by r.ordinal desc limit 1`, sessionId);
    const row = rows[0];
    if (!row) return;
    const userId = turnUsageAuthor(JSON.parse(String(row.payload_json)));
    if (!userId) throw new Error("Turn author missing; cannot check usage limits.");
    return { userId, chatId: String(row.thread_id), turnId: String(row.run_id) };
  }
  /** Called before OpenCode accepts a prompt. No check is made while the answer runs. */
  async beforeTurn(sessionId: string, promptId?: string): Promise<Response | undefined> {
    await this.init();
    const author = await this.author(sessionId, promptId);
    if (!author) return;
    const existing = await this.all("select context from baskule_usage_context where session_id=? order by min_seq desc limit 1", sessionId);
    if (existing[0] && (JSON.parse(String(existing[0].context)) as TurnUsageContext).turnId === author.turnId) return;
    await this.capture();
    const now = Date.now();
    let cached = this.cache.get(author.userId);
    if (!cached || cached.until <= now || this.settingsUntil <= now) {
      try {
        // Include outstanding records in the check, so a quick next turn sees its predecessor even before flush.
        // Ingestion and receipts are idempotent, including a concurrent background flush.
        let records: UsageRecord[];
        do {
          records = await this.pending();
          const version = this.settingsVersion;
          const response = await this.control("/_baskule/usage/check", { spaceId: this.spaceId, userId: author.userId, records });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const { limits, settings, accepted } = await response.json() as { limits: UsageWindowStatus[]; settings: UsageLimitSettings; accepted: string[] };
          if (version !== this.settingsVersion) return this.beforeTurn(sessionId, promptId);
          this.settings = settings;
          for (const id of accepted) await this.all("update baskule_usage_outbox set record=null where message_id=?", id);
          cached = { until: Math.min(now + 5_000, ...limits.map(s => Date.parse(s.resetsAt))), limits };
          this.settingsUntil = now + 5_000;
          this.cache.set(author.userId, cached);
        } while (records.length === 100);
      } catch {
        if (this.settings.enabled) return Response.json({ _tag: "InvalidRequestError", kind: "usage_check_unavailable", error: "usage_check_unavailable", message: "Usage limits could not be checked. Please try again." }, { status: 400 });
        cached = { until: now, limits: [] };
      }
    }
    const blocked = cached.limits.find(s => s.blocked && Date.parse(s.resetsAt) > now);
    if (blocked) return Response.json({ _tag: "InvalidRequestError", kind: "usage_limit_reached", field: JSON.stringify(blocked), error: "usage_limit_reached", code: "usage_limit_reached", status: blocked,
      message: `Your ${blocked.window} usage limit has been reached. It resets at ${blocked.resetsAt}.` }, { status: 400 });
    const context: TurnUsageContext = { ...author, modelPrices: this.modelPrices };
    const seq = Number((await this.all("select coalesce(max(seq),0)+1 as seq from session_message where session_id=?", sessionId))[0].seq);
    await this.all("insert into baskule_usage_context(prompt_id,session_id,min_seq,started_at,context) values(?,?,?,?,?) on conflict do nothing",
      promptId ?? crypto.randomUUID(), sessionId, seq, now, JSON.stringify(context));
  }
  private async context(sessionId: string, seq: number, created: number): Promise<TurnUsageContext | undefined> {
    const row = (await this.all("select context from baskule_usage_context where session_id=? and min_seq<=? order by min_seq desc limit 1", sessionId, seq))[0];
    if (row) return JSON.parse(String(row.context));
    // Native OpenCode subagents run inside the initiating turn and inherit that turn's author and price snapshot.
    const parent = (await this.all("select parent_id from session_v2 where id=?", sessionId))[0]?.parent_id;
    if (!parent) return;
    const ancestor = (await this.all("select context from baskule_usage_context where session_id=? and started_at<=? order by started_at desc limit 1", String(parent), created))[0];
    return ancestor ? JSON.parse(String(ancestor.context)) : this.context(String(parent), Number.MAX_SAFE_INTEGER, created);
  }
  capture(): Promise<void> {
    if (this.capturing) return this.capturing;
    this.capturing = (async () => {
      await this.init();
      const rows = await this.all(`select m.id,m.session_id,m.seq,m.data from session_message m
        left join baskule_usage_outbox o on o.message_id=m.id where m.type='assistant' and o.message_id is null
        and json_extract(m.data,'$.time.completed') is not null and json_extract(m.data,'$.tokens') is not null order by m.time_created,m.seq`);
      for (const row of rows) {
        const m = JSON.parse(String(row.data)) as { model: { id: string; providerID: string }; time: { created: number; completed: number }; tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } };
        const c = await this.context(String(row.session_id), Number(row.seq), m.time.created);
        if (!c) continue;
        const { modelPrices, ...author } = c;
        const prices = modelPrices[`${m.model.providerID}/${m.model.id}`];
        const tokens: UsageTokens = { input: m.tokens.input, output: m.tokens.output, reasoning: m.tokens.reasoning, cacheRead: m.tokens.cache.read, cacheWrite: m.tokens.cache.write };
        const record: UsageRecord = { ...author, messageId: String(row.id), spaceId: this.spaceId, provider: m.model.providerID, model: m.model.id,
          occurredAt: new Date(m.time.completed).toISOString(), tokens, prices, costUsd: usageCost(tokens, prices) };
        await this.all("insert into baskule_usage_outbox(message_id,record) values(?,?) on conflict do nothing", record.messageId, JSON.stringify(record));
        this.cache.delete(c.userId);
      }
    })().finally(() => { this.capturing = undefined; });
    return this.capturing;
  }
  async hasPending() {
    await this.init();
    return (await this.pending()).length > 0;
  }
  private async pending(): Promise<UsageRecord[]> {
    return (await this.all("select record from baskule_usage_outbox where record is not null limit 100")).map(r => JSON.parse(String(r.record)));
  }
  flush(): Promise<boolean> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      await this.capture();
      const records = await this.pending();
      if (!records.length) return false;
      try {
        const response = await this.control("/_baskule/usage", { spaceId: this.spaceId, records });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { accepted } = await response.json() as { accepted: string[] };
        const sent = new Set(records.map(r => r.messageId));
        for (const id of accepted) if (sent.has(id)) await this.all("update baskule_usage_outbox set record=null where message_id=?", id);
      } catch { /* Durable outbox is retried by the existing agent alarm. */ }
      const pending = (await this.pending()).length > 0;
      if (pending) await this.retry();
      return pending;
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
}
