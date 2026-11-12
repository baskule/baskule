import { z } from "zod";
import { PLUGIN_PROVIDERS, type CatalogSource, type ProviderId } from "../../../../app/packages/contracts/src/baskule-plugins";
import { json, notFound, pluginError } from "../../shared/http";
import { readBounded } from "../../shared/read-bounded";
import type { ConnectionCipher } from "../connection-crypto";
import type { StorageLike } from "../service";
import { PluginAdmin, schemas } from "./admin";
import { CatalogCache, REGISTRIES, loadProvider, loadRegistry } from "./catalog";
import { PluginConnections } from "./connections";
import type { Fetcher } from "./fetch";
import { originKey, PluginStore } from "./store";

interface Options {
  fetcher?: Fetcher;
  anonymous: boolean;
  reload: (spaceIds: string[] | "all") => Promise<void>;
  memberSpaceIds: (userId: string) => string[];
  revalidateWaitMs?: number;
}

async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const bytes = await readBounded(req.body, 256 * 1024, pluginError(413, "plugin_too_large"));
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw pluginError(400, "invalid_request", "A JSON body is required"); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw pluginError(400, "invalid_request", parsed.error.message);
  return parsed.data;
}

const credentialInput = z.object({ spaceId: z.string().min(1).max(200), userId: z.string().min(1).max(200), pluginId: z.string().min(1).max(200), serverId: z.string().min(1).max(200) }).strict();
const isProvider = (value: string): value is ProviderId => (PLUGIN_PROVIDERS as readonly string[]).includes(value);

export class Plugins {
  readonly store: PluginStore;
  readonly catalog: CatalogCache;
  readonly admin: PluginAdmin;
  readonly connections: PluginConnections;
  constructor(storage: StorageLike, cipher: ConnectionCipher, private options: Options) {
    const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.store = new PluginStore(storage, cipher, fetcher);
    const kv = {
      get: (key: string) => this.store.rows("select value from kv where key=?", key)[0]?.value as string | undefined,
      put: (key: string, value: string) => void this.store.rows("insert into kv(key,value) values (?,?) on conflict(key) do update set value=excluded.value", key, value),
      delete: (key: string) => void this.store.rows("delete from kv where key=?", key),
    };
    this.catalog = new CatalogCache(kv, (source: CatalogSource) => {
      const registry = REGISTRIES.find(r => r.id === source);
      if (registry) return previous => loadRegistry(fetcher, registry, previous);
      if (!isProvider(source) || !this.store.configuredProviders().has(source)) return null;
      return async () => {
        const client = await this.store.provider(source);
        if (!client) throw new Error("Not configured");
        return loadProvider(source, client);
      };
    }, options.revalidateWaitMs);
    this.admin = new PluginAdmin(this.store, this.catalog);
    this.connections = new PluginConnections(this.store, userId => options.reload(userId === null ? "all" : options.memberSpaceIds(userId)), options.anonymous);
  }

  /** `/api/baskule/admin/*` plugin routes, after the caller is known to be an administrator; null for other paths. */
  async adminRoute(req: Request, path: string, url: URL, userId: string): Promise<Response | null> {
    const m = req.method;
    if (path === "/catalog" && m === "GET") {
      const providers = this.store.configuredProviders();
      const installed = new Map(this.store.list().map(p => [originKey(p.def.origin), p.id] as const).filter(([key]) => key));
      return json(await this.catalog.catalog(url.searchParams.get("refresh") === "1", { composio: providers.has("composio"), pipedream: providers.has("pipedream") }, installed, originKey));
    }
    if (path === "/plugins/preview" && m === "POST") return json(await this.admin.preview((await body(req, schemas.preview)).ref));
    if (path === "/plugins" && m === "GET") return json(await this.admin.list(url.origin));
    if (path === "/plugins" && m === "POST") {
      const { id } = await this.admin.install(await body(req, schemas.install), userId);
      await this.options.reload("all");
      return json(await this.admin.one(id), 201);
    }
    const plugin = /^\/plugins\/([^/]+)$/.exec(path)?.[1];
    if (plugin && m === "GET") return json(await this.admin.one(plugin));
    if (plugin && m === "PATCH") {
      await this.admin.update(plugin, await body(req, schemas.update));
      await this.options.reload("all");
      return json(await this.admin.one(plugin));
    }
    if (plugin && m === "DELETE") {
      await this.admin.remove(plugin);
      await this.options.reload("all");
      return json({ ok: true });
    }
    if (path === "/oauth-clients" && (m === "PUT" || m === "DELETE")) {
      if (m === "PUT") await this.admin.saveOAuthClient(await body(req, schemas.oauthClient));
      else this.admin.removeOAuthClient(url.searchParams.get("issuer") ?? "");
      await this.options.reload("all");
      return json(await this.store.oauthClients(url.origin));
    }
    const provider = /^\/plugin-providers\/([^/]+)$/.exec(path)?.[1];
    if (provider && (m === "PUT" || m === "DELETE")) {
      if (!isProvider(provider)) return notFound();
      if (m === "PUT") await this.admin.saveProvider(provider, await body(req, schemas.provider));
      else this.admin.removeProvider(provider);
      await this.options.reload("all");
      return json(await this.store.providerSettings());
    }
    return null;
  }

  /** `/api/baskule/plugins*` for a signed-in member; null for other paths. */
  async memberRoute(req: Request, path: string, url: URL, user: { id: string }, sessionId: string): Promise<Response | null> {
    const m = req.method;
    if (path === "/plugins" && m === "GET") return json(await this.connections.list(user.id));
    if (path === "/plugins/oauth/callback" && m === "GET") return this.connections.oauthCallback(url, user.id, sessionId);
    if (path === "/plugins/provider/callback" && m === "GET") return this.connections.providerCallback(url, user.id, sessionId);
    const server = /^\/plugins\/([^/]+)\/servers\/([^/]+)\/(connect|connection)$/.exec(path);
    if (server?.[3] === "connect" && m === "GET") return this.connections.connect(url, user, sessionId, server[1]!, server[2]!);
    if (server?.[3] === "connection" && m === "DELETE") {
      await this.connections.disconnect(user.id, server[1]!, server[2]!);
      return json({ ok: true });
    }
    const plugin = /^\/plugins\/([^/]+)$/.exec(path)?.[1];
    if (plugin && m === "PUT") {
      await this.connections.setOn(user.id, plugin, (await body(req, z.object({ on: z.boolean() }).strict())).on);
      return json({ ok: true });
    }
    return null;
  }

  async credentialRoute(req: Request): Promise<Response> {
    return json(await this.connections.credential(await body(req, credentialInput)));
  }
}
