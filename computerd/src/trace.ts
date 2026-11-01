// Minimal OTLP/HTTP (JSON) span export, no SDK: one span per API request and one per computer lifecycle step,
// nested through AsyncLocalStorage. An incoming W3C `traceparent` header makes them children of the caller's span.
// OTLP_TRACES_URL (…/v1/traces) enables it; unset: every call here is a no-op.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { log } from "./log.ts";

type Value = string | number | boolean;
interface Parent { traceId: string; spanId: string }
interface Finished extends Parent {
  parentSpanId?: string; name: string; kind: number; start: bigint; end: bigint;
  attributes: Record<string, Value>; error?: string;
}

const FLUSH_MS = 2_000;
const MAX_QUEUE = 4_096;
const MAX_BATCH = 512;

const url = process.env.OTLP_TRACES_URL || "";
const current = new AsyncLocalStorage<Parent>();
let queue: Finished[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let warned = false;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
// Wall-clock nanoseconds, monotonic within the process; split so the double never needs 1e18 precision.
const nowNs = () => {
  const ms = performance.timeOrigin + performance.now();
  return BigInt(Math.floor(ms)) * 1_000_000n + BigInt(Math.round((ms % 1) * 1e6));
};

/** `00-<trace>-<span>-<flags>` → the parent it names, or undefined. */
export function parseTraceparent(header: string | string[] | undefined): Parent | undefined {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(String(header ?? "").trim());
  return m && !/^0+$/.test(m[1]) && !/^0+$/.test(m[2]) ? { traceId: m[1], spanId: m[2] } : undefined;
}

export interface Span {
  set(attributes: Record<string, Value | undefined>): void;
  end(error?: unknown): void;
  /** Runs `fn` with this span as the parent of spans started inside it. */
  within<T>(fn: () => T): T;
}

const NOOP: Span = { set() {}, end() {}, within: (fn) => fn() };

/** Starts a span under the current one (or `parent`). Server spans are kind 2, internal ones kind 1. */
export function startSpan(name: string, attributes: Record<string, Value | undefined> = {}, opts: { parent?: Parent; server?: boolean } = {}): Span {
  if (!url) return NOOP;
  const parent = opts.parent ?? current.getStore();
  const self: Parent = { traceId: parent?.traceId ?? hex(16), spanId: hex(8) };
  const attrs: Record<string, Value> = {};
  const set = (more: Record<string, Value | undefined>) => {
    for (const [k, v] of Object.entries(more)) if (v !== undefined) attrs[k] = v;
  };
  set(attributes);
  const start = nowNs();
  let ended = false;
  return {
    set,
    end(error) {
      if (ended) return;
      ended = true;
      enqueue({
        ...self, parentSpanId: parent?.spanId, name, kind: opts.server ? 2 : 1, start, end: nowNs(), attributes: attrs,
        ...(error === undefined ? {} : { error: String((error as any)?.message ?? error).slice(0, 300) }),
      });
    },
    within: (fn) => current.run(self, fn),
  };
}

/** `fn` inside a child span that ends (with its error, if any) when `fn` settles. */
export async function traced<T>(name: string, attributes: Record<string, Value | undefined>, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = startSpan(name, attributes);
  try {
    const result = await span.within(() => fn(span));
    span.end();
    return result;
  } catch (e) {
    span.end(e);
    throw e;
  }
}

function enqueue(span: Finished) {
  if (queue.length >= MAX_QUEUE) return; // the collector is gone or slow: drop rather than grow
  queue.push(span);
  if (!timer) {
    timer = setInterval(() => void flush(), FLUSH_MS);
    timer.unref();
  }
}

export async function flush() {
  while (queue.length) {
    const batch = queue.splice(0, MAX_BATCH);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlp(batch)),
        signal: AbortSignal.timeout(3_000),
      });
      if (!r.ok) throw new Error(`collector answered ${r.status}`);
    } catch (e: any) {
      if (!warned) log.warn("trace export failed (further failures are silent)", { err: String(e?.message ?? e) });
      warned = true;
      return;
    }
  }
}

const value = (v: Value) =>
  typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } :
  Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };

function otlp(spans: Finished[]) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "baskule-computerd" } }] },
      scopeSpans: [{
        scope: { name: "baskule-computerd" },
        spans: spans.map((s) => ({
          traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name, kind: s.kind, startTimeUnixNano: String(s.start), endTimeUnixNano: String(s.end),
          attributes: Object.entries(s.attributes).map(([key, v]) => ({ key, value: value(v) })),
          status: s.error === undefined ? { code: 1 } : { code: 2, message: s.error },
        })),
      }],
    }],
  };
}
