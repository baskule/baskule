export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
  // Better Auth APIError: { status: "BAD_REQUEST", statusCode: 400, body: { code, message } }
  const a = e as { statusCode?: number; body?: { code?: string; message?: string } };
  if (typeof a?.statusCode === "number" && a.statusCode >= 400 && a.statusCode < 600)
    return json({ error: a.body?.code ?? "auth_error", message: a.body?.message ?? "" }, a.statusCode);
  console.error("internal error", e);
  return json({ error: "internal_error" }, 500);
}

export const notFound = () => json({ error: "not_found" }, 404);

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const v = await req.json();
    if (v && typeof v === "object") return v as T;
  } catch {}
  throw new HttpError(400, "invalid_json", "a JSON object body is required");
}

export const SPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
