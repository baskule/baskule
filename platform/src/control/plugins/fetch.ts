import { pluginError } from "../../shared/http";
import { checkOutbound, type Network } from "../../shared/plugin-outbound";
import { readBounded } from "../../shared/read-bounded";

export type Fetcher = typeof fetch;

/** `status` is null when the request never got an answer (network failure, timeout, oversized body). */
export class OutboundError extends Error {
  constructor(readonly status: number | null, readonly body = "") { super(status === null ? "unreachable" : `HTTP ${status}`); }
}

export interface Answer { status: number; headers: Headers; text: string }

/** Bounded, redirect-free outbound request. Answers every status; throws only when no answer arrived. */
export async function send(fetcher: Fetcher, target: string, init: RequestInit & { limit?: number; timeoutMs?: number; network?: Network } = {}): Promise<Answer> {
  const { limit = 2 * 1024 * 1024, timeoutMs = 15_000, network = "public", ...rest } = init;
  const url = checkOutbound(target, network);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url.href, { ...rest, redirect: "error", signal: controller.signal });
    const bytes = await readBounded(response.body, limit, pluginError(413, "plugin_too_large"), controller.signal);
    return { status: response.status, headers: response.headers, text: new TextDecoder().decode(bytes) };
  } catch { throw new OutboundError(null); }
  finally { clearTimeout(timer); }
}

export async function sendOk(fetcher: Fetcher, target: string, init: Parameters<typeof send>[2] = {}): Promise<string> {
  const answer = await send(fetcher, target, init);
  if (answer.status < 200 || answer.status >= 300) throw new OutboundError(answer.status, answer.text.slice(0, 500));
  return answer.text;
}

export function json(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
