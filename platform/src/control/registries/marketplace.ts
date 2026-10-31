import { z } from "zod";
import type { PluginSearchResult } from "../../../../app/packages/contracts/src/baskule-plugins";
import { pluginError } from "../../shared/http";
import { fetchJson, fetchBytes, type Fetcher } from "./http";
import type { Registry, ResolvedPlugin } from "./index";

const catalog = z.object({ plugins: z.array(z.object({
  name: z.string(), description: z.string().default(""), source: z.unknown(), skills: z.array(z.string()).optional(),
})) });
export const COMMIT_RE = /^[a-f0-9]{40}$/i;
export function githubRepo(repo: string): string {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repo);
  if (!m) throw pluginError(400, "unsupported_git_host", "Use a public HTTPS GitHub repository and a full commit SHA");
  return m[1];
}
export class GithubMarketplace implements Registry {
  constructor(readonly id: string, private repo: string, private fetcher: Fetcher, private allowed?: string[], private catalogPath = ".claude-plugin/marketplace.json") {}
  private async read(version?: string) {
    let sha = version;
    if (sha && !COMMIT_RE.test(sha)) throw pluginError(400, "invalid_commit");
    if (!sha) {
      const head = z.object({ sha: z.string().regex(COMMIT_RE) }).parse(await fetchJson(this.fetcher, `https://api.github.com/repos/${this.repo}/commits/HEAD`));
      sha = head.sha;
    }
    const data = await fetchBytes(this.fetcher, `https://raw.githubusercontent.com/${this.repo}/${sha}/${this.catalogPath}`, 2 * 1024 * 1024);
    return { sha, plugins: catalog.parse(JSON.parse(new TextDecoder().decode(data))).plugins.filter(p => !this.allowed || this.allowed.includes(p.name)) };
  }
  async search(q: string, kind?: PluginSearchResult["kind"]) {
    if (kind === "mcp") return [];
    const { sha, plugins } = await this.read();
    return plugins.filter(p => `${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase())).flatMap(p => {
      const k = p.skills ? "skill" as const : "bundle" as const;
      if (kind && kind !== k) return [];
      return [{ id: p.name, name: p.name, description: p.description, kind: k,
        source: { type: "registry" as const, registry: this.id, id: p.name, version: sha } }];
    }).slice(0, 50);
  }
  async resolve(id: string, version?: string): Promise<ResolvedPlugin> {
    const { sha, plugins } = await this.read(version);
    const p = plugins.find(p => p.name === id);
    if (!p) throw pluginError(404, "registry_plugin_not_found");
    let source: Extract<ResolvedPlugin["source"], { type: "git" }>;
    if (typeof p.source === "string" && p.source.startsWith("./"))
      source = { type: "git", repo: `https://github.com/${this.repo}`, ref: sha, path: p.source.slice(2) };
    else {
      const local = z.object({ source: z.literal("local"), path: z.string().startsWith("./") }).safeParse(p.source);
      if (local.success) return { source: { type: "git", repo: `https://github.com/${this.repo}`, ref: sha, path: local.data.path.slice(2) }, name: p.name, description: p.description, skillPaths: p.skills };
      const external = z.object({ source: z.enum(["url", "git-subdir"]), url: z.string(), sha: z.string().regex(COMMIT_RE), path: z.string().optional() }).safeParse(p.source);
      if (!external.success) throw pluginError(400, "unsupported_marketplace_source", "This catalog entry has no pinned public GitHub source; import its repository at a commit instead");
      githubRepo(external.data.url);
      source = { type: "git", repo: external.data.url, ref: external.data.sha, path: external.data.path };
    }
    return { source, name: p.name, description: p.description, skillPaths: p.skills };
  }
}
