import { z } from "zod";
import type { PluginKind, PluginServer } from "../../../../app/packages/contracts/src/baskule-plugins";
import type { Registry, ResolvedPlugin } from "./index";
import { fetchJson, type Fetcher } from "./http";
import { HttpError } from "../../shared/http";

const entry = z.object({ server: z.object({
  name: z.string(), title: z.string().optional(), description: z.string().default(""), version: z.string(),
  remotes: z.array(z.object({ type: z.string(), url: z.string(), headers: z.array(z.object({ isSecret: z.boolean().optional(), isRequired: z.boolean().optional() })).optional() })).default([]),
}), _meta: z.record(z.string(), z.unknown()).optional() });
const base = "https://registry.modelcontextprotocol.io/v0.1/servers";
function servers(e: z.infer<typeof entry>): PluginServer[] {
  return e.server.remotes.flatMap((remote, i) => {
    if (!["streamable-http", "sse"].includes(remote.type) || /[{}]/.test(remote.url)) return [];
    let url: URL;
    try { url = new URL(remote.url); } catch { return []; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return [];
    return [{ name: `remote-${i + 1}`, url: url.href, credential: remote.headers?.some(h => h.isSecret || h.isRequired) ? "organization" : "none", personal: false, transport: remote.type as "sse" | "streamable-http" }];
  });
}
function active(e: z.infer<typeof entry>) {
  const meta = e._meta?.["io.modelcontextprotocol.registry/official"] as { status?: string } | undefined;
  return !meta?.status || meta.status === "active";
}
export class McpRegistry implements Registry {
  readonly id = "mcp";
  constructor(private fetcher: Fetcher) {}
  async search(q: string, kind?: PluginKind) {
    if (kind && kind !== "mcp") return [];
    const url = new URL(base);
    url.search = new URLSearchParams({ search: q, version: "latest", limit: "100" }).toString();
    const body = z.object({ servers: z.array(z.unknown()) }).parse(await fetchJson(this.fetcher, url.href));
    return body.servers.flatMap(raw => {
      const parsed = entry.safeParse(raw);
      if (!parsed.success || !active(parsed.data) || !servers(parsed.data).length) return [];
      const s = parsed.data.server;
      return [{ id: s.name, name: s.title ?? s.name, description: s.description, kind: "mcp" as const,
        source: { type: "registry" as const, registry: this.id, id: s.name, version: s.version } }];
    });
  }
  async resolve(id: string, version = "latest"): Promise<ResolvedPlugin> {
    const e = entry.parse(await fetchJson(this.fetcher, `${base}/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`));
    const remotes = servers(e);
    if (!active(e) || !remotes.length) throw new HttpError(400, "no_remote_servers");
    return { source: { type: "url", url: remotes[0].url }, name: e.server.title ?? e.server.name, description: e.server.description, servers: remotes };
  }
}
