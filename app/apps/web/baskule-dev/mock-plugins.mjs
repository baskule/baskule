// baskule: the plugins and groups part of the mock front (shapes: packages/contracts/src/baskule-plugins.ts,
// behaviour: platform/src/control/plugins.ts and groups.ts). In memory, seeded with a few plugins people
// added themselves; catalog installs come from the real curated list. `/connect` signs in at once and
// redirects back, as after a real consent. A vendor app is only remembered as saved, never its values.
import * as NodeCrypto from "node:crypto";

import { catalogService, catalogVendor } from "../../../packages/contracts/src/baskule-catalog.ts";

const EVERYONE = "everyone";
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = () => NodeCrypto.randomUUID();
const at = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();

/** As `pluginFromCatalog`: the service id is the plugin id, and its vendor is set up once. */
function pluginFromCatalog(service) {
  const signIn = catalogVendor(service.vendor).signIn;
  return {
    id: service.id,
    vendor: service.vendor,
    name: service.name,
    description: service.description,
    icon: service.icon,
    source: { type: "catalog" },
    skills: [],
    servers: service.servers.map((server) => ({
      name: server.name,
      url: server.url,
      transport: server.transport ?? "streamable-http",
      credential:
        signIn.type === "account" ? "user-oauth" : signIn.type === "key" ? "organization" : "none",
      ...(signIn.type === "account"
        ? {
            oauth: {
              ...(server.scopes ? { scopes: server.scopes } : {}),
              ...(signIn.client === "static" ? { staticClient: true } : {}),
            },
          }
        : {}),
    })),
    ignored: [],
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

/** A plugin an admin added by address, git repository or file. */
function ownPlugin(fields) {
  const pluginId = id();
  return {
    id: pluginId,
    vendor: pluginId,
    description: "",
    skills: [],
    servers: [],
    ignored: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

export function createPluginMock({ users, spaces }) {
  /** @type {Map<string, any>} */
  const plugins = new Map();
  const seed = (fields) => {
    const plugin = ownPlugin(fields);
    plugins.set(plugin.id, plugin);
    return plugin.id;
  };
  const brave = seed({
    name: "Brave Search",
    description: "Web and news search through the Brave Search API.",
    source: { type: "url", url: "https://mcp.search.brave.com/mcp" },
    servers: [
      {
        name: "brave-search",
        url: "https://mcp.search.brave.com/mcp",
        credential: "organization",
        transport: "streamable-http",
      },
    ],
    createdAt: at(5),
  });
  const sales = seed({
    name: "Sales",
    description: "Prepare calls, research accounts and draft follow-ups, with your CRM connected.",
    source: {
      type: "git",
      repo: "https://github.com/anthropics/knowledge-work-plugins",
      ref: "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4",
      path: "sales",
    },
    skills: [
      {
        name: "call-prep",
        description: "Prepare a sales call from the account's history and news.",
      },
      { name: "account-research", description: "Build a short brief on a company and its people." },
    ],
    servers: [
      {
        name: "hubspot",
        url: "https://mcp.hubspot.com/anthropic",
        credential: "organization",
        transport: "streamable-http",
      },
    ],
    ignored: [
      "commands/forecast.md (made for Claude Code)",
      "hooks/hooks.json (made for Claude Code)",
    ],
    enabled: false,
    createdAt: at(2),
  });
  // Added by address with its own sign-in app, already saved, so people can connect it at once.
  const driveId = id();
  const drive = {
    id: driveId,
    vendor: driveId,
    name: "Google Drive",
    description: "Find and read the files people can open in their own Google Drive.",
    source: { type: "url", url: "https://drivemcp.googleapis.com/mcp/v1" },
    skills: [],
    servers: [
      {
        name: "drive",
        url: "https://drivemcp.googleapis.com/mcp/v1",
        credential: "user-oauth",
        oauth: { staticClient: true },
        transport: "streamable-http",
      },
    ],
    ignored: [],
    enabled: true,
    createdAt: at(4),
  };
  plugins.set(drive.id, drive);

  /** @type {Array<{id: string, name: string, builtin?: "everyone", members: string[], permissions: {canCreateSpaces: boolean}, plugins: string[]}>} */
  const groups = [
    {
      id: EVERYONE,
      name: "Everyone",
      builtin: "everyone",
      members: [],
      permissions: { canCreateSpaces: false },
      plugins: [brave, drive.id],
    },
    {
      id: "g-sales",
      name: "Sales",
      members: ["u-alice"],
      permissions: { canCreateSpaces: true },
      plugins: [sales],
    },
  ];
  /** `${pluginId}\0${server}` with an organization key */
  const secrets = new Set([`${brave}\u0000brave-search`]);
  /** Vendor keys with a saved app. Drive's is saved so people can connect it at once. */
  const vendors = new Set([drive.vendor]);
  /** space id -> { personalPluginsAllowed, disabled } */
  const spaceSettings = new Map();

  const listGroups = () =>
    groups.map((group) => ({
      ...group,
      members: group.builtin
        ? [...users.keys()].sort()
        : group.members.filter((member) => users.has(member)),
    }));
  const grantsOf = (userId) => {
    const applicable = listGroups().filter(
      (group) => group.builtin || group.members.includes(userId),
    );
    return {
      canCreateSpaces: applicable.some((group) => group.permissions.canCreateSpaces),
      plugins: new Set(applicable.flatMap((group) => group.plugins)),
    };
  };
  const connected = new Set();
  const connectionKey = (userId, pluginId, server) => `${userId}\u0000${pluginId}\u0000${server}`;
  /** Whether the shared part of a server's sign-in is done: its organization key or its vendor's app. */
  const setupDone = (plugin, server) =>
    server.credential === "organization"
      ? secrets.has(`${plugin.id}\u0000${server.name}`)
      : server.credential !== "user-oauth" ||
        !server.oauth?.staticClient ||
        vendors.has(plugin.vendor);
  const connectionState = (plugin, server, userId) =>
    !plugin.enabled
      ? "unavailable"
      : !setupDone(plugin, server)
        ? "needs_setup"
        : server.credential !== "user-oauth" ||
            connected.has(connectionKey(userId, plugin.id, server.name))
          ? "ready"
          : "connect";

  async function install(body) {
    if ("catalog" in body) {
      const service = catalogService(String(body.catalog));
      if (!service || Object.keys(body).some((key) => key !== "catalog" && key !== "groups"))
        return [
          service ? 400 : 404,
          { error: service ? "invalid_plugin_input" : "catalog_unknown" },
        ];
      if (service.notYet) return [409, { error: "catalog_not_available" }];
      if (plugins.has(service.id)) return [409, { error: "already_installed" }];
      return [201, pluginFromCatalog(service)];
    }
    const source = body.source ?? {};
    if (source.type === "url") {
      let url;
      try {
        url = new URL(String(source.url));
      } catch {
        return [400, { error: "invalid_mcp_url" }];
      }
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search)
        return [400, { error: "invalid_mcp_url" }];
      const pluginId = id();
      return [
        201,
        {
          id: pluginId,
          vendor: pluginId,
          name: body.name || url.hostname,
          description: "",
          source: { type: "url", url: url.href },
          skills: [],
          servers: [
            {
              name: "remote",
              url: url.href,
              credential: "none",
              transport: "streamable-http",
            },
          ],
          ignored: [],
          enabled: true,
          createdAt: new Date().toISOString(),
        },
      ];
    }
    if (source.type === "git") {
      if (!/^[0-9a-f]{40}$/.test(String(source.ref))) return [400, { error: "invalid_commit" }];
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(String(source.repo)))
        return [400, { error: "unsupported_git_host" }];
      const folder = String(source.path ?? "")
        .split("/")
        .filter(Boolean)
        .at(-1);
      const repo = String(source.repo).replace(/\/+$/, "").split("/").at(-1);
      const pluginId = id();
      return [
        201,
        {
          id: pluginId,
          vendor: pluginId,
          name: body.name || folder || repo,
          description: "",
          source,
          skills: [{ name: folder || repo, description: "Imported from the repository." }],
          servers: [],
          ignored: [],
          enabled: true,
          createdAt: new Date().toISOString(),
        },
      ];
    }
    if (source.type === "archive") {
      const bytes = Buffer.from(String(body.archive ?? ""), "base64");
      if (!bytes.length) return [400, { error: "archive_required" }];
      if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== source.sha256)
        return [400, { error: "archive_hash_mismatch" }];
      const pluginId = id();
      return [
        201,
        {
          id: pluginId,
          vendor: pluginId,
          name: body.name || "Uploaded skill",
          description: "",
          source,
          skills: [{ name: "uploaded-skill", description: "From the uploaded file." }],
          servers: [],
          ignored: [],
          enabled: true,
          createdAt: new Date().toISOString(),
        },
      ];
    }
    return [400, { error: "invalid_plugin_input" }];
  }

  /** Answers the plugin and group routes; returns false for every other route. */
  async function handle({ req, res, url, api, me, isAdmin, send, fail, readBody }) {
    const method = req.method ?? "GET";
    let r;
    if (
      api.startsWith("/admin/plugins") ||
      api.startsWith("/admin/groups") ||
      api.startsWith("/admin/vendors")
    ) {
      if (!isAdmin) return (fail(res, 403, "forbidden"), true);
    }
    if (api === "/admin/plugins" && method === "GET")
      return (
        send(res, 200, {
          plugins: [...plugins.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((plugin) => ({
              ...plugin,
              setup: plugin.servers.map((server) => ({
                server: server.name,
                done: setupDone(plugin, server),
              })),
              vendorConfigured: vendors.has(plugin.vendor),
            })),
        }),
        true
      );
    if ((r = /^\/admin\/vendors\/([^/]+)$/.exec(api))) {
      const vendor = decodeURIComponent(r[1]);
      const owned = [...plugins.values()].filter((plugin) => plugin.vendor === vendor);
      if (owned.length === 0) return (fail(res, 404, "vendor_unknown"), true);
      if (method === "PUT") {
        const body = await readBody(req);
        if (body !== null) {
          const auth = body?.tokenEndpointAuthMethod;
          const signIn = catalogVendor(vendor)?.signIn;
          if (
            typeof body?.clientId !== "string" ||
            !body.clientId ||
            !["none", "client_secret_post", "client_secret_basic"].includes(auth) ||
            (auth !== "none") !== Boolean(body.clientSecret) ||
            (body.tenant !== undefined && !TENANT.test(String(body.tenant))) ||
            (signIn?.type === "account" &&
              signIn.client === "static" &&
              signIn.fields?.includes("tenant") &&
              !body.tenant)
          )
            return (fail(res, 400, "invalid_oauth_client"), true);
          vendors.add(vendor);
        } else vendors.delete(vendor);
        // Saving or removing an app disconnects every account of this vendor.
        for (const key of connected)
          if (owned.some((plugin) => key.split("\u0000")[1] === plugin.id)) connected.delete(key);
        return (send(res, 200, { ok: true, configured: vendors.has(vendor) }), true);
      }
    }
    if (api === "/admin/plugins" && method === "POST") {
      const input = await readBody(req);
      if (
        !Array.isArray(input.groups) ||
        input.groups.some((id) => !groups.some((g) => g.id === id))
      )
        return (fail(res, 400, "invalid_group"), true);
      const [status, body] = await install(input);
      if (status === 201) {
        plugins.set(body.id, body);
        for (const group of groups)
          if (input.groups.includes(group.id)) group.plugins.push(body.id);
      }
      return (send(res, status, body), true);
    }
    if ((r = /^\/admin\/plugins\/([^/]+)(\/secret)?$/.exec(api))) {
      const plugin = plugins.get(r[1]);
      if (!plugin) return (fail(res, 404, "not_found"), true);
      if (r[2] && method === "PUT") {
        const body = await readBody(req);
        if (
          !plugin.servers.some(
            (server) => server.name === body.server && server.credential === "organization",
          )
        )
          return (fail(res, 400, "not_organization_server"), true);
        const key = `${plugin.id}\u0000${body.server}`;
        if (body.headers === null) secrets.delete(key);
        else if (!body.headers || Object.keys(body.headers).length === 0)
          return (fail(res, 400, "invalid_secret_headers"), true);
        else secrets.add(key);
        return (send(res, 200, { ok: true }), true);
      }
      if (method === "DELETE") {
        // A catalog plugin's vendor setup is shared by the vendor's other services.
        if (plugin.source.type !== "catalog") vendors.delete(plugin.vendor);
        plugins.delete(plugin.id);
        for (const group of groups)
          group.plugins = group.plugins.filter((entry) => entry !== plugin.id);
        return (send(res, 200, { ok: true }), true);
      }
      if (method === "PATCH") {
        const patch = await readBody(req);
        if (plugin.source.type === "catalog" && Object.keys(patch).some((key) => key !== "enabled"))
          return (fail(res, 409, "not_editable"), true);
        const { servers, ...fields } = patch;
        if (servers) {
          plugin.servers = plugin.servers.map((server) => ({
            ...server,
            ...servers.find((entry) => entry.name === server.name),
          }));
          for (const server of plugin.servers)
            if (server.credential !== "organization")
              secrets.delete(`${plugin.id}\u0000${server.name}`);
        }
        Object.assign(plugin, fields);
        return (send(res, 200, plugin), true);
      }
    }
    if ((r = /^\/admin\/groups(?:\/([^/]+))?$/.exec(api))) {
      const current = r[1] ? groups.find((group) => group.id === r[1]) : undefined;
      if (r[1] && !current) return (fail(res, 404, "not_found"), true);
      if (method === "GET")
        return (
          send(
            res,
            200,
            r[1] ? listGroups().find((group) => group.id === r[1]) : { groups: listGroups() },
          ),
          true
        );
      if (r[1] && method === "DELETE") {
        if (current.builtin) return (fail(res, 409, "builtin_group"), true);
        groups.splice(groups.indexOf(current), 1);
        return (send(res, 200, { ok: true }), true);
      }
      if ((!r[1] && method === "POST") || (r[1] && method === "PATCH")) {
        const body = await readBody(req);
        if (
          current?.builtin &&
          (body.members !== undefined || (body.name !== undefined && body.name !== current.name))
        )
          return (fail(res, 409, "builtin_group"), true);
        const name = String(body.name ?? current?.name ?? "").trim();
        if (!name) return (fail(res, 400, "invalid_group"), true);
        if (groups.some((group) => group.name === name && group !== current))
          return (fail(res, 409, "group_exists"), true);
        const next = current ?? {
          id: id(),
          name,
          members: [],
          permissions: { canCreateSpaces: false },
          plugins: [],
        };
        next.name = name;
        if (body.members) next.members = [...new Set(body.members)];
        if (body.permissions)
          next.permissions = { canCreateSpaces: Boolean(body.permissions.canCreateSpaces) };
        if (body.plugins)
          next.plugins = [...new Set(body.plugins)].filter((entry) => plugins.has(entry));
        if (!current) groups.push(next);
        return (
          send(
            res,
            current ? 200 : 201,
            listGroups().find((group) => group.id === next.id),
          ),
          true
        );
      }
    }
    if (api === "/plugins" && method === "GET") {
      const allowed = grantsOf(me.id).plugins;
      return (
        send(res, 200, {
          plugins: [...plugins.values()]
            .filter((plugin) => allowed.has(plugin.id))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((plugin) => {
              const servers = plugin.servers.map((server) => ({
                name: server.name,
                credential: server.credential,
                status: connectionState(plugin, server, me.id),
              }));
              const status = !plugin.enabled
                ? "unavailable"
                : (["needs_setup", "connect", "reconnect", "ready"].find((s) =>
                    servers.some((server) => server.status === s),
                  ) ?? "ready");
              return {
                id: plugin.id,
                name: plugin.name,
                description: plugin.description,
                icon: plugin.icon,
                skills: plugin.skills,
                status,
                servers,
              };
            }),
        }),
        true
      );
    }
    if ((r = /^\/plugins\/([^/]+)\/(connect|connection)$/.exec(api))) {
      const plugin = plugins.get(r[1]);
      if (!plugin || !grantsOf(me.id).plugins.has(r[1])) return (fail(res, 404, "not_found"), true);
      const server = url.searchParams.get("server");
      if (r[2] === "connection" && method === "DELETE") {
        for (const s of plugin.servers)
          if (server === null || s.name === server)
            connected.delete(connectionKey(me.id, plugin.id, s.name));
        return (send(res, 200, { ok: true }), true);
      }
      if (r[2] === "connect" && method === "GET") {
        const target = plugin.servers.find((s) => s.name === server);
        if (!target) return (fail(res, 400, "unknown_server"), true);
        const back = new URL(url.searchParams.get("returnTo") ?? "/", url.origin);
        // A refused start comes back like a failed sign-in.
        if (!setupDone(plugin, target)) {
          back.searchParams.set("pluginConnection", "error");
          back.searchParams.set("connectionError", "oauth_client_configuration_required");
        } else {
          connected.add(connectionKey(me.id, plugin.id, target.name));
          back.searchParams.set("pluginConnection", "connected");
        }
        res.writeHead(302, { location: back.pathname + back.search });
        res.end();
        return true;
      }
    }
    if ((r = /^\/spaces\/([^/]+)\/plugins$/.exec(api))) {
      const space = spaces.get(r[1]);
      const role = space?.members.find((member) => member.userId === me.id)?.role;
      if (!space || (!role && !isAdmin)) return (fail(res, 404, "not_found"), true);
      if (role !== "owner" && !isAdmin) return (fail(res, 403, "forbidden"), true);
      const current = spaceSettings.get(space.id) ?? {
        personalPluginsAllowed: false,
        disabled: [],
      };
      if (method === "GET") return (send(res, 200, current), true);
      if (method === "PUT") {
        const body = await readBody(req);
        const next = {
          personalPluginsAllowed: Boolean(body.personalPluginsAllowed),
          disabled: [...new Set(body.disabled ?? [])].filter((entry) => plugins.has(entry)).sort(),
        };
        spaceSettings.set(space.id, next);
        return (send(res, 200, next), true);
      }
    }
    return false;
  }

  return {
    handle,
    canCreateSpaces: (user) => user.role === "admin" || grantsOf(user.id).canCreateSpaces,
  };
}
