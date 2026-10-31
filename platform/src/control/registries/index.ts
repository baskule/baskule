import type { PluginSearchResult, PluginServer, PluginSource, PluginSearchResponse } from "../../../../app/packages/contracts/src/baskule-plugins";
import { McpRegistry } from "./mcp";
import { GithubMarketplace } from "./marketplace";
import type { Fetcher } from "./http";

export interface ResolvedPlugin {
  source: Exclude<PluginSource, { type: "registry" | "archive" }>;
  name: string;
  description: string;
  servers?: PluginServer[];
  skillPaths?: string[];
}
export interface Registry {
  id: string;
  search(q: string, kind?: PluginSearchResult["kind"]): Promise<PluginSearchResult[]>;
  resolve(id: string, version?: string): Promise<ResolvedPlugin>;
}

export function registries(fetcher: Fetcher = fetch): Registry[] {
  return [new McpRegistry(fetcher),
    new GithubMarketplace("anthropic-knowledge-work", "anthropics/knowledge-work-plugins", fetcher),
    new GithubMarketplace("anthropic-skills", "anthropics/skills", fetcher, ["example-skills"]),
    new GithubMarketplace("claude-plugins", "anthropics/claude-plugins-official", fetcher),
    new GithubMarketplace("codex-plugins", "openai/plugins", fetcher, undefined, ".agents/plugins/marketplace.json")];
}

export async function searchRegistries(sources: Registry[], q: string, kind?: PluginSearchResult["kind"]): Promise<PluginSearchResponse> {
  const settled = await Promise.allSettled(sources.map(r => r.search(q, kind)));
  return {
    results: settled.flatMap(r => r.status === "fulfilled" ? r.value : []),
    failures: settled.flatMap((r, i) => r.status === "rejected" ? [{ registry: sources[i].id, error: "unavailable" as const }] : []),
  };
}
