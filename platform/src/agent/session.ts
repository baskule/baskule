// Session-create interception (pure, unit-tested): binds a new OpenCode session to the space's computer workspace.
// The client's permission rules are kept as sent.

/** Drops null (and undefined) fields recursively: T3 sends `null` for absent optional fields, which OpenCode's
 *  in-process create (no HTTP schema decoding) would keep. */
export function stripNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(stripNulls) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null && x !== undefined)
        .map(([k, x]) => [k, stripNulls(x)]),
    ) as T;
  }
  return v;
}

/** Computer paths only: absolute, under /sandbox, no `.`/`..` segments. Returns the normalized path or null. */
export function computerPath(p: unknown): string | null {
  if (typeof p !== "string" || !p.startsWith("/")) return null;
  const segs = p.split("/").filter(Boolean);
  if (segs.some((s) => s === "." || s === "..")) return null;
  const norm = "/" + segs.join("/");
  return norm === "/sandbox" || norm.startsWith("/sandbox/") ? norm : null;
}


export type Prepared = { input: Record<string, unknown>; directory: string | null } | { error: string };

export interface ModelRef { providerID: string; id: string }
/** The models this installation's OpenCode offers (`provider/model`), and the one a chat falls back to. */
export interface Models { offered: ReadonlySet<string>; fallback: ModelRef }

/** A chat keeps any offered model it selected. If that model is no longer offered (for example, an admin replaced
 *  the installation's model), the chat runs on the installation's default instead of failing every turn. */
export function offeredModel(model: unknown, models: Models): ModelRef {
  const m = model as Partial<ModelRef> | null | undefined;
  return m && typeof m.providerID === "string" && typeof m.id === "string" && models.offered.has(`${m.providerID}/${m.id}`)
    ? (m as ModelRef)
    : models.fallback;
}

export function prepareSessionCreate(body: unknown, workspaceID: string, defaultDirectory: string, models: Models): Prepared {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };
  const input = stripNulls(body as Record<string, unknown>);
  if (input.model !== undefined) input.model = offeredModel(input.model, models);
  if (typeof input.parentID === "string") {
    // A child session is created at its parent's location (already on the computer workspace).
    delete input.location;
    return { input, directory: null };
  }
  const loc = (input.location ?? {}) as { directory?: unknown };
  const directory = loc.directory === undefined ? defaultDirectory : computerPath(loc.directory);
  if (!directory) return { error: "location.directory must be an absolute path under /sandbox" };
  input.location = { directory, workspaceID };
  return { input, directory };
}
