import { z } from "zod";
import type { PluginSource } from "../../../app/packages/contracts/src/baskule-plugins";
import { IMPORT_LIMITS, safePath } from "./plugin-import";
import { pluginError } from "../shared/http";

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

export const COMMIT_RE = /^[a-f0-9]{40}$/i;
export function githubRepo(repo: string): string {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repo);
  if (!m) throw pluginError(400, "unsupported_git_host", "Use a public HTTPS GitHub repository and a full commit SHA");
  return m[1];
}


export async function fetchGitFiles(fetcher: Fetcher, source: Extract<PluginSource, { type: "git" }>): Promise<Map<string, Uint8Array>> {
  const repo = githubRepo(source.repo);
  const prefix = source.path ? `${safePath(source.path)}/` : "";
  const license = (p: string) => /(?:^|\/)(?:LICENSE(?:\.txt)?|NOTICE)$/i.test(p);
  const tree = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), size: z.number().optional() })) }).parse(
    await fetchJson(fetcher, `https://api.github.com/repos/${repo}/git/trees/${source.ref}?recursive=1`));
  if (tree.truncated) throw pluginError(413, "plugin_tree_too_large", "Upload the selected plugin directory as an archive instead");
  const entries = tree.tree.filter(e => e.type !== "tree" && (
    e.path.startsWith(prefix) ||
    (license(e.path) && prefix.startsWith(e.path.slice(0, e.path.lastIndexOf("/") + 1)))
  ));
  if (entries.length > IMPORT_LIMITS.files || entries.reduce((n, e) => n + (e.size ?? IMPORT_LIMITS.expanded + 1), 0) > IMPORT_LIMITS.expanded)
    throw pluginError(413, "plugin_too_large");
  for (const e of entries) {
    safePath(e.path);
    if (!["100644", "100755"].includes(e.mode)) throw pluginError(400, "plugin_links_unsupported");
  }
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < entries.length; i += 6) {
    const batch = await Promise.all(entries.slice(i, i + 6).map(async e => {
      const url = `https://raw.githubusercontent.com/${repo}/${source.ref}/${e.path.split("/").map(encodeURIComponent).join("/")}`;
      const bytes = await fetchBytes(fetcher, url, e.size!);
      if (bytes.length !== e.size) throw pluginError(502, "plugin_source_changed");
      return [e.path, bytes] as const;
    }));
    for (const [path, bytes] of batch) files.set(path, bytes);
  }
  return files;
}
