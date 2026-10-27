import { z } from "zod";
import type { PluginSource } from "../../../../app/packages/contracts/src/baskule-plugins";
import { HttpError } from "../../shared/http";
import { IMPORT_LIMITS, safePath } from "../plugin-import";
import { fetchBytes, fetchJson, type Fetcher } from "./http";
import { githubRepo } from "./marketplace";

/** Fetch only the selected directory: whole marketplace repositories can exceed the archive limit. */
export async function fetchGitFiles(fetcher: Fetcher, source: Extract<PluginSource, { type: "git" }>, skillPaths?: string[]): Promise<Map<string, Uint8Array>> {
  const repo = githubRepo(source.repo);
  const prefix = source.path ? `${safePath(source.path)}/` : "";
  const selected = skillPaths?.map(p => `${prefix}${safePath(p)}/`);
  const license = (p: string) => /(?:^|\/)(?:LICENSE(?:\.txt)?|NOTICE)$/i.test(p);
  const tree = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), size: z.number().optional() })) }).parse(
    await fetchJson(fetcher, `https://api.github.com/repos/${repo}/git/trees/${source.ref}?recursive=1`));
  if (tree.truncated) throw new HttpError(413, "plugin_tree_too_large", "Upload the selected plugin directory as an archive instead");
  const entries = tree.tree.filter(e => e.type !== "tree" && (
    (e.path.startsWith(prefix) && (!selected || selected.some(p => e.path.startsWith(p)) || (!e.path.slice(prefix.length).includes("/") && license(e.path)))) ||
    (license(e.path) && prefix.startsWith(e.path.slice(0, e.path.lastIndexOf("/") + 1)))
  ));
  if (entries.length > IMPORT_LIMITS.files || entries.reduce((n, e) => n + (e.size ?? IMPORT_LIMITS.expanded + 1), 0) > IMPORT_LIMITS.expanded)
    throw new HttpError(413, "plugin_too_large");
  for (const e of entries) {
    safePath(e.path);
    if (!["100644", "100755"].includes(e.mode)) throw new HttpError(400, "plugin_links_unsupported");
  }
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < entries.length; i += 6) {
    const batch = await Promise.all(entries.slice(i, i + 6).map(async e => {
      const url = `https://raw.githubusercontent.com/${repo}/${source.ref}/${e.path.split("/").map(encodeURIComponent).join("/")}`;
      const bytes = await fetchBytes(fetcher, url, e.size!);
      if (bytes.length !== e.size) throw new HttpError(502, "plugin_source_changed");
      return [e.path, bytes] as const;
    }));
    for (const [path, bytes] of batch) files.set(path, bytes);
  }
  return files;
}
