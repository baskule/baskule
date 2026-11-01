import { z } from "zod";
import type { PluginSource } from "../../../app/packages/contracts/src/baskule-plugins";
import { IMPORT_LIMITS, safePath } from "./plugin-package";
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
export async function resolveGithubLink(fetcher: Fetcher, link: string): Promise<Extract<PluginSource, { type: "github" }>> {
  const normalized = link.trim().replace(/^github\.com\//, "https://github.com/");
  let url: URL;
  try { url = new URL(normalized.includes("://") ? normalized : `https://github.com/${normalized}`); }
  catch { throw pluginError(400, "github_link_invalid"); }
  if (url.origin !== "https://github.com" || url.username || url.password) throw pluginError(400, "github_link_invalid");
  let parts: string[];
  try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
  catch { throw pluginError(400, "github_link_invalid"); }
  const [owner, rawRepo, kind, ...tail] = parts;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || [owner, repo].some(p => p === "." || p === "..")) throw pluginError(400, "github_link_invalid");
  if (kind && !["tree", "blob", "commit"].includes(kind)) throw pluginError(400, "github_link_invalid");
  const commit = async (ref: string) => {
    let response: Response;
    try { response = await fetcher(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, { redirect: "error", signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS), headers: { accept: "application/vnd.github.sha", "User-Agent": "Baskule" } }); }
    catch { throw pluginError(502, "plugin_source_unavailable"); }
    if (response.status === 404 || response.status === 422) { await response.body?.cancel(); return undefined; }
    if (!response.ok) { await response.body?.cancel(); throw pluginError(502, "plugin_source_unavailable"); }
    const sha = new TextDecoder().decode(await readBounded(response.body, 1024)).trim();
    if (!COMMIT_RE.test(sha)) throw pluginError(502, "plugin_source_unavailable");
    return sha.toLowerCase();
  };
  const result = (sha: string, path?: string): Extract<PluginSource, { type: "github" }> => ({ type: "github", repo: `https://github.com/${owner}/${repo}`, sha, ...(path ? { path: safePath(path) } : {}) });
  if (!kind) { const sha = await commit("HEAD"); if (sha) return result(sha); }
  else {
    if (!tail.length || (kind === "commit" && tail.length !== 1)) throw pluginError(400, "github_link_invalid");
    for (let count = Math.min(tail.length, 5); count > 0; count--) {
      const ref = tail.slice(0, count).join("/");
      const sha = await commit(ref);
      if (sha) {
        const rest = tail.slice(count);
        if (kind === "blob") { if (rest.at(-1) !== "SKILL.md") throw pluginError(400, "github_link_invalid"); rest.pop(); }
        return result(sha, rest.join("/"));
      }
    }
  }
  throw pluginError(400, "github_link_invalid");
}

export async function fetchGitFiles(fetcher: Fetcher, source: Extract<PluginSource, { type: "github" }>): Promise<Map<string, Uint8Array>> {
  const repo = new URL(source.repo).pathname.slice(1);
  const prefix = source.path ? `${safePath(source.path)}/` : "";
  const license = (p: string) => /(?:^|\/)(?:LICENSE(?:\.txt)?|NOTICE)$/i.test(p);
  const tree = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), size: z.number().optional() })) }).parse(
    await fetchJson(fetcher, `https://api.github.com/repos/${repo}/git/trees/${source.sha}?recursive=1`));
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
      const url = `https://raw.githubusercontent.com/${repo}/${source.sha}/${e.path.split("/").map(encodeURIComponent).join("/")}`;
      const bytes = await fetchBytes(fetcher, url, e.size!);
      if (bytes.length !== e.size) throw pluginError(502, "plugin_source_changed");
      return [e.path, bytes] as const;
    }));
    for (const [path, bytes] of batch) files.set(path, bytes);
  }
  return files;
}
