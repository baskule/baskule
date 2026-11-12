import { pluginError } from "../../shared/http";
import { OutboundError, json, sendOk, type Fetcher } from "./fetch";
import { LIMITS, LINK, OVERSIZED, isFetchedComponent, safePath, type RepoFile } from "./package";

const COMMIT = /^[a-f0-9]{40}$/;
const API = { "user-agent": "Baskule", accept: "application/vnd.github+json" };

export const rawUrl = (repo: string, sha: string, path: string) =>
  `https://raw.githubusercontent.com/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;

const unreadable = (error: unknown): never => {
  if (error instanceof OutboundError) throw pluginError(error.status === 404 || error.status === 422 ? 404 : 502, "source_unreadable");
  throw error;
};

/** The commit and tree a ref names. GitHub's API allows 60 unauthenticated requests per hour. */
export async function resolveCommit(fetcher: Fetcher, repo: string, ref = "HEAD"): Promise<{ sha: string; tree: string }> {
  const text = await sendOk(fetcher, `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, { headers: API, limit: 512_000 }).catch(unreadable);
  const commit = json(text) as { sha?: string; commit?: { tree?: { sha?: string } } } | null;
  const sha = commit?.sha?.toLowerCase();
  const tree = commit?.commit?.tree?.sha?.toLowerCase();
  if (!sha || !COMMIT.test(sha) || !tree || !COMMIT.test(tree)) throw pluginError(502, "source_unreadable");
  if (COMMIT.test(ref) && ref.toLowerCase() !== sha) throw pluginError(409, "plugin_changed");
  return { sha, tree };
}

export interface TreeEntry { path: string; type: string; mode: string; size?: number }
export async function repoTree(fetcher: Fetcher, repo: string, tree: string): Promise<TreeEntry[]> {
  const text = await sendOk(fetcher, `https://api.github.com/repos/${repo}/git/trees/${tree}?recursive=1`, { headers: API, limit: 8_000_000 }).catch(unreadable);
  const listing = json(text) as { truncated?: boolean; tree?: TreeEntry[] } | null;
  if (!listing || listing.truncated || !Array.isArray(listing.tree)) throw pluginError(413, "plugin_too_large");
  return listing.tree;
}

/** The plugin directory at a pinned commit: component text is fetched, other paths are only listed. */
export async function fetchPluginFiles(fetcher: Fetcher, repo: string, sha: string, tree: string, path?: string): Promise<RepoFile[]> {
  const prefix = path ? `${safePath(path)}/` : "";
  const files: RepoFile[] = [];
  const wanted: string[] = [];
  const selected = (await repoTree(fetcher, repo, tree)).filter(entry => entry.path.startsWith(prefix));
  if (selected.length > LIMITS.treeEntries) throw pluginError(413, "plugin_too_large");
  for (const entry of selected) {
    const relative = entry.path.slice(prefix.length);
    if (entry.mode === "120000" || entry.type === "commit") { files.push({ path: relative, content: LINK }); continue; }
    if (entry.type !== "blob") continue;
    if (!isFetchedComponent(relative)) { files.push({ path: relative, content: "" }); continue; }
    if ((entry.size ?? 0) > LIMITS.fileBytes) { files.push({ path: relative, content: OVERSIZED }); continue; }
    wanted.push(relative);
  }
  if (path && !selected.length) throw pluginError(404, "source_unreadable", `Folder "${path}" was not found`);
  if (wanted.length > LIMITS.files) throw pluginError(413, "plugin_too_large");
  let total = 0;
  const queue = [...wanted];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const content = await sendOk(fetcher, rawUrl(repo, sha, prefix + next), { limit: LIMITS.fileBytes }).catch(unreadable);
      total += content.length;
      if (total > LIMITS.bytes) throw pluginError(413, "plugin_too_large");
      files.push({ path: next, content });
    }
  }));
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
