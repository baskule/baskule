import { pluginError } from "../../shared/http";

export type Fetcher = typeof fetch;
export const SOURCE_TIMEOUT_MS = 8_000;

export async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number, tooLarge = pluginError(413, "plugin_too_large"), signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  const abort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw signal.reason;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) throw tooLarge;
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (signal?.aborted) throw signal.reason;
  return bytes.subarray(0, size);
}

export async function fetchBytes(fetcher: Fetcher, url: string, limit: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { signal: controller.signal, headers: { "User-Agent": "Baskule/0.4.0", accept: "application/json" } });
    if (!response.ok) { await response.body?.cancel(); throw pluginError(502, "plugin_source_unavailable"); }
    return await readBounded(response.body, limit);
  } finally { clearTimeout(timeout); }
}

export async function fetchJson(fetcher: Fetcher, url: string): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(fetcher, url, 2 * 1024 * 1024)));
}
