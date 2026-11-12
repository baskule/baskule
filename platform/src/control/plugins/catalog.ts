// Registry indexes and their completeness gate follow Rakazo's marketplace adapter (Apache-2.0).
import { z } from "zod";
import type { Catalog, CatalogEntry, CatalogSource, ProviderId, RegistryId } from "../../../../app/packages/contracts/src/baskule-plugins";
import { OutboundError, json, sendOk, type Fetcher } from "./fetch";
import { rawUrl, repoTree, resolveCommit } from "./github";
import { classifyIndexed, classifyPluginFiles, collectMcpServers, parseGithubUrl, type Completeness } from "./package";
import { providerCategory, type Provider } from "./providers";
import { brandKey, comparePlugins, displayName, isRecommended, pluginCategory } from "./ranking";

export const TTL_MS = 60 * 60_000;
const STALE_REFRESH_MS = 2 * 60_000;
const CONCURRENCY = 16;

interface Registry { id: RegistryId; repo: string; index: string; manifest: string; components: string | null; serversOnly?: boolean; skip?: string[] }
export const REGISTRIES: Registry[] = [
  // Anthropic's directories vendor some plugins and pin the rest to the vendor's own repository. The official
  // directory's plugins without a server are Claude Code developer tools (commit, review, plugin authoring).
  { id: "anthropic", repo: "anthropics/claude-plugins-official", index: ".claude-plugin/marketplace.json", manifest: ".claude-plugin/plugin.json", components: null, serversOnly: true },
  // Role packs (sales, finance, legal…): skills plus the services each role uses. Plugin management is Cowork's own.
  { id: "anthropic-work", repo: "anthropics/knowledge-work-plugins", index: ".claude-plugin/marketplace.json", manifest: ".claude-plugin/plugin.json", components: null,
    skip: ["cowork-plugin-management"] },
  // Every listed plugin is vendored in the registry repo, so its file list tells its parts.
  { id: "cursor", repo: "cursor/plugins", index: ".cursor-plugin/marketplace.json", manifest: ".cursor-plugin/plugin.json", components: null },
  // The registry generates a parts index for each pinned plugin, including ones hosted elsewhere.
  { id: "xai", repo: "xai-org/plugin-marketplace", index: ".grok-plugin/marketplace.json", manifest: ".grok-plugin/plugin.json", components: ".grok-plugin/plugin-index.json" },
];

/** What a catalog entry installs from: a pinned GitHub directory or a provider app. */
export type EntryRef = { repo: string; path?: string; sha: string } | { provider: ProviderId; app: string };
export type StoredEntry = Omit<CatalogEntry, "installedPluginId"> & { ref: EntryRef };
/** `pinned` remembers which plugins hosted elsewhere were checked, so a new registry commit only reads new pins. */
export interface CachedSource { fetchedAt: number; sha?: string; entries: StoredEntry[]; pinned?: Record<string, StoredEntry | null> }

const entrySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).optional().catch(undefined),
  keywords: z.array(z.string().max(120)).max(50).optional().catch(undefined),
  category: z.string().trim().min(1).max(60).optional().catch(undefined),
  homepage: z.string().url().max(2048).optional().catch(undefined),
  domains: z.array(z.string().max(253)).max(20).optional().catch(undefined),
  displayName: z.string().trim().min(1).max(120).optional().catch(undefined),
  skills: z.array(z.string().max(2048)).max(200).optional().catch(undefined),
  lspServers: z.unknown().optional(),
  source: z.union([
    z.string().max(2048),
    z.object({ source: z.enum(["url", "git-subdir"]), url: z.string().max(2048), sha: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().max(2048).optional() }),
    z.object({ type: z.literal("local"), path: z.string().startsWith("./").max(2048) }),
  ]),
});
const manifestSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional().catch(undefined),
  category: z.string().trim().min(1).max(60).optional().catch(undefined),
  logo: z.string().regex(/^(?!\/)(?!.*\.\.)[\w./-]+\.(svg|png|jpe?g|webp)$/i).max(512).optional().catch(undefined),
});
const componentSchema = z.object({ plugins: z.record(z.string(), z.object({ sha: z.string().optional(),
  components: z.record(z.string(), z.array(z.object({ description: z.string().optional() }))) })) });

interface IndexEntry { name: string; displayName: string | null; skills: number; description: string; keywords: string[]; category: string | null; homepage: string | null; domains: string[]; repo: string; path?: string; sha: string }

/** Public indexes are discovery hints; preview validates and pins the selected package. */
export function parseIndex(text: string, registry: Registry, registrySha: string): IndexEntry[] {
  const index = json(text) as { plugins?: unknown } | null;
  if (!index || !Array.isArray(index.plugins) || index.plugins.length > 1000) throw new Error("Invalid marketplace index");
  const entries: IndexEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of index.plugins) {
    const parsed = entrySchema.safeParse(candidate);
    if (!parsed.success) continue;
    const { source, ...entry } = parsed.data;
    // Language servers only run inside an editor.
    if (entry.lspServers !== undefined) continue;
    try {
      let repo = registry.repo, path: string | undefined, sha = registrySha;
      if (typeof source === "string") {
        if (source.startsWith("https://")) ({ repo, path } = parseGithubUrl(source));
        else path = source.replace(/^\.\//, "");
      } else if ("url" in source) {
        const ref = parseGithubUrl(source.path ? `${source.url}#${source.path.replace(/^\.?\//, "")}` : source.url);
        if (ref.ref && ref.ref !== source.sha) continue;
        ({ repo, path } = ref);
        sha = source.sha;
      } else path = source.path.slice(2);
      if (path) path = path.replace(/\/$/, "");
      const key = `${repo}@${sha}#${path ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ name: entry.name, displayName: entry.displayName ?? null, skills: entry.skills?.length ?? 0, description: entry.description ?? "", keywords: entry.keywords ?? [], category: entry.category?.toLowerCase() ?? null,
        homepage: entry.homepage ?? null, domains: entry.domains ?? [], repo, ...(path ? { path } : {}), sha });
    } catch {}
  }
  return entries;
}

export const entryId = (source: CatalogSource, ref: EntryRef) =>
  "provider" in ref ? `${source}:${ref.app}` : `${source}:https://github.com/${ref.repo}#${ref.path ?? ""}`;

async function pool<T>(items: T[], work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item); }));
}

async function optionalText(fetcher: Fetcher, url: string, limit: number): Promise<string | undefined> {
  try { return await sendOk(fetcher, url, { limit }); }
  catch (error) { if (error instanceof OutboundError && error.status === 404) return undefined; throw error; }
}

/** Server hosts make a plugin findable by its vendor, e.g. "google" finds Gmail through gmailmcp.googleapis.com.
 * They are keywords, not domains: domains pick the logo, and a pack's first server is not its brand. */
export function serverHosts(config: string | undefined): string[] {
  if (!config) return [];
  try {
    const servers = (JSON.parse(config) as { mcpServers?: Record<string, { url?: unknown }> }).mcpServers ?? {};
    return Object.values(servers).flatMap(server => {
      if (typeof server?.url !== "string" || server.url.includes("${")) return [];
      try { return [new URL(server.url).hostname]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

/**
 * A plugin pinned to another repository, read from its manifest and MCP config alone: listing it must not spend the
 * GitHub API budget (60 requests an hour) on a tree per plugin. It is listed only for hosted servers; preview reads all of it.
 */
async function classifyPinned(fetcher: Fetcher, registry: Registry, entry: IndexEntry): Promise<{ parts: Completeness; hosts: string[]; manifest: string | undefined } | null> {
  const base = entry.path ? `${entry.path}/` : "";
  const manifest = await optionalText(fetcher, rawUrl(entry.repo, entry.sha, base + registry.manifest), 64_000);
  const declared = (manifest === undefined ? {} : json(manifest) ?? {}) as Record<string, unknown>;
  if (["hooks", "lspServers", "outputStyles"].some(key => declared[key] !== undefined)) return null;
  let config: string | undefined;
  if (declared.mcpServers && typeof declared.mcpServers === "object") config = JSON.stringify({ mcpServers: declared.mcpServers });
  else {
    const file = typeof declared.mcpServers === "string" ? declared.mcpServers.replace(/^\.\//, "") : ".mcp.json";
    if (file.includes("..")) return null;
    config = await optionalText(fetcher, rawUrl(entry.repo, entry.sha, base + file), 256_000);
  }
  if (config === undefined) return null;
  const collected = collectMcpServers(json(config));
  if (collected.skipped.some(s => s.kind !== "blank_server") || !collected.servers.length) return null;
  return { parts: { hasServers: true, skillCount: entry.skills }, hosts: serverHosts(config), manifest };
}

/** A connector's site behind its one MCP host, for the logo fallback: mcp.stripe.com → stripe.com. Packs with skills keep their own. */
const vendorSite = (host: string) => host.split(".").length > 2 ? host.slice(host.indexOf(".") + 1) : host;

/** One registry at its current commit; logos are pinned to the commit that was read. */
export async function loadRegistry(fetcher: Fetcher, registry: Registry, previous: CachedSource | null): Promise<CachedSource> {
  const { sha, tree } = await resolveCommit(fetcher, registry.repo);
  if (previous?.sha === sha) return { ...previous, fetchedAt: Date.now() };
  const listed = parseIndex(await sendOk(fetcher, rawUrl(registry.repo, sha, registry.index), { limit: 2_000_000 }), registry, sha);
  const [blobs, components] = await Promise.all([
    registry.components ? Promise.resolve([]) : repoTree(fetcher, registry.repo, tree).then(entries => entries.filter(e => e.type === "blob")),
    registry.components ? sendOk(fetcher, rawUrl(registry.repo, sha, registry.components), { limit: 2_000_000 }).then(text => componentSchema.parse(json(text))) : Promise.resolve(null),
  ]);
  const sizes = new Map(blobs.map(e => [e.path, e.size ?? 0]));
  const entries: StoredEntry[] = [];
  const pinned: Record<string, StoredEntry | null> = {};
  await pool(listed.filter(entry => !registry.skip?.includes(entry.name)), async entry => {
    const dir = entry.path ?? "";
    const base = dir ? `${dir}/` : "";
    let parts: Completeness | null = null;
    let hosts: string[] = [];
    let manifestText: string | undefined;
    const pinKey = `${entry.repo}@${entry.sha}#${dir}`;
    if (!components && entry.repo !== registry.repo) {
      if (previous?.pinned && pinKey in previous.pinned) {
        const known = previous.pinned[pinKey] ?? null;
        pinned[pinKey] = known;
        if (known) entries.push(known);
        return;
      }
      const classified = await classifyPinned(fetcher, registry, entry).catch(() => undefined);
      // A vendor repository that could not be read is retried on the next refresh.
      if (classified === undefined) return;
      if (!classified) { pinned[pinKey] = null; return; }
      ({ parts, hosts } = classified);
      manifestText = classified.manifest ?? "";
    } else if (components) {
      const indexed = components.plugins[entry.name];
      // The index describes one pinned commit; another pin may have other parts.
      if (indexed && (!indexed.sha || indexed.sha === entry.sha)) parts = classifyIndexed(indexed.components);
    } else if (entry.repo === registry.repo) {
      const own = blobs.filter(e => e.path.startsWith(base)).map(e => e.path.slice(base.length));
      const mcp = own.find(p => p === "mcp.json" || p === ".mcp.json");
      const config = mcp ? await optionalText(fetcher, rawUrl(entry.repo, entry.sha, base + mcp), 256_000) : undefined;
      const classified = classifyPluginFiles(own, config, new Map(own.map(p => [p, sizes.get(base + p) ?? 0])));
      parts = classified === "incomplete" ? null : classified;
      hosts = serverHosts(config);
    }
    if (!parts || (registry.serversOnly && !parts.hasServers)) return;
    const text = manifestText !== undefined ? manifestText || undefined : await optionalText(fetcher, rawUrl(entry.repo, entry.sha, base + registry.manifest), 64_000);
    const manifest = manifestSchema.safeParse(text === undefined ? {} : json(text)).data ?? {};
    const ref = { repo: entry.repo, ...(entry.path ? { path: entry.path } : {}), sha: entry.sha };
    const stored: StoredEntry = { id: entryId(registry.id, ref), source: registry.id, name: entry.name, displayName: manifest.displayName ?? entry.displayName ?? displayName(entry.name),
      description: entry.description, logo: manifest.logo ? rawUrl(entry.repo, entry.sha, base + manifest.logo.replace(/^\.\//, "")) : null,
      homepage: entry.homepage, domains: entry.domains.length || hosts.length !== 1 || parts.skillCount ? entry.domains : [vendorSite(hosts[0]!)], keywords: [...new Set([...entry.keywords, ...hosts])].slice(0, 50), category: pluginCategory(entry.name, entry.category ?? manifest.category ?? null),
      recommended: isRecommended(entry.name), hasServers: parts.hasServers, skillCount: parts.skillCount, ref };
    entries.push(stored);
    if (!components && entry.repo !== registry.repo) pinned[pinKey] = stored;
  });
  return { fetchedAt: Date.now(), sha, entries: entries.sort((a, b) => a.id.localeCompare(b.id)), ...(Object.keys(pinned).length ? { pinned } : {}) };
}

export async function loadProvider(provider: ProviderId, client: Provider): Promise<CachedSource> {
  const entries = (await client.apps()).map((app): StoredEntry => {
    const ref = { provider, app: app.slug };
    return { id: entryId(provider, ref), source: provider, name: app.slug, displayName: app.name, description: app.description, logo: app.logo,
      homepage: null, domains: [], keywords: [], category: providerCategory(app), recommended: false, hasServers: true, skillCount: 0, ref };
  });
  return { fetchedAt: Date.now(), entries };
}

/** One brand is listed once across registries: the entry with a logo, then the first registry's. */
export function dedupe(entries: StoredEntry[]): StoredEntry[] {
  const best = new Map<string, StoredEntry>();
  const order = (source: CatalogSource) => REGISTRIES.findIndex(r => r.id === source);
  const score = (e: StoredEntry) => (e.logo ? 0 : REGISTRIES.length) + order(e.source);
  for (const entry of entries) {
    const key = brandKey(entry.displayName) || brandKey(entry.name);
    const current = best.get(key);
    if (!current || score(entry) < score(current)) best.set(key, entry);
  }
  return [...best.values()].sort(comparePlugins);
}

interface KV { get(key: string): string | undefined; put(key: string, value: string): void; delete(key: string): void }

/** kv-cached sources with a 1 h TTL. Stale copies are served while a refresh runs; failures are never cached. */
export class CatalogCache {
  private failures = new Map<CatalogSource, string>();
  private running = new Map<CatalogSource, { started: number; work: Promise<CachedSource> }>();
  constructor(private kv: KV, private loaders: (source: CatalogSource) => ((previous: CachedSource | null) => Promise<CachedSource>) | null, private revalidateWaitMs = 4_000) {}

  cached(source: CatalogSource): CachedSource | null {
    const value = this.kv.get(`catalog:${source}`);
    return value ? JSON.parse(value) as CachedSource : null;
  }
  forget(source: CatalogSource) { this.kv.delete(`catalog:${source}`); this.failures.delete(source); }

  private refresh(source: CatalogSource, load: (previous: CachedSource | null) => Promise<CachedSource>): Promise<CachedSource> {
    const running = this.running.get(source);
    // ControlCell has no keepalive for work that outlives its request; a refresh that never settled is abandoned.
    if (running && Date.now() - running.started < STALE_REFRESH_MS) return running.work;
    const work = load(this.cached(source)).then(data => {
      this.kv.put(`catalog:${source}`, JSON.stringify(data));
      this.failures.delete(source);
      return data;
    }, (error: unknown) => {
      this.failures.set(source, error instanceof Error ? error.message.slice(0, 300) : "Unavailable");
      throw error;
    }).finally(() => { if (this.running.get(source)?.work === work) this.running.delete(source); });
    this.running.set(source, { started: Date.now(), work });
    return work;
  }

  async source(source: CatalogSource, force: boolean): Promise<CachedSource | null> {
    const load = this.loaders(source);
    if (!load) return null;
    const cached = this.cached(source);
    if (force || !cached) return this.refresh(source, load).catch(() => cached);
    if (Date.now() - cached.fetchedAt < TTL_MS) return cached;
    const work = this.refresh(source, load).catch(() => cached);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([work, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.revalidateWaitMs); })]);
    clearTimeout(timer);
    return waited ?? cached;
  }

  async catalog(force: boolean, providers: Record<ProviderId, boolean>, installed: ReadonlyMap<string, string>, originKey: (ref: EntryRef) => string): Promise<Catalog> {
    const sources: CatalogSource[] = [...REGISTRIES.map(r => r.id), ...(["composio", "pipedream"] as const).filter(p => providers[p])];
    const loaded = await Promise.all(sources.map(async source => [source, await this.source(source, force)] as const));
    const withInstalled = (entry: StoredEntry): CatalogEntry => {
      const { ref, ...rest } = entry;
      return { ...rest, installedPluginId: installed.get(originKey(ref)) ?? null };
    };
    const registries = dedupe(loaded.filter(([s]) => REGISTRIES.some(r => r.id === s)).flatMap(([, data]) => data?.entries ?? []));
    const apps = loaded.filter(([s]) => s === "composio" || s === "pipedream").flatMap(([, data]) => data?.entries ?? []);
    const times = loaded.flatMap(([, data]) => data ? [data.fetchedAt] : []);
    return {
      entries: [...registries, ...apps].map(withInstalled),
      unavailable: sources.flatMap(source => this.failures.has(source) ? [{ source, message: this.failures.get(source)! }] : []),
      refreshedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
      providers,
    };
  }

  /** An entry from the cache, loading the source once when nothing is cached. */
  async entry(id: string): Promise<StoredEntry | undefined> {
    const source = id.slice(0, id.indexOf(":")) as CatalogSource;
    const data = this.cached(source) ?? await this.source(source, false).catch(() => null);
    return data?.entries.find(e => e.id === id);
  }
}
