import { HttpError } from "./http";

export async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number, tooLarge = new HttpError(413, "too_large"), signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
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
