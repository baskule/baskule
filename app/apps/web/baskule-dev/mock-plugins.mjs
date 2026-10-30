// baskule: the plugins and groups part of the mock front (shapes: packages/contracts/src/baskule-plugins.ts,
// behaviour: platform/src/control/plugins.ts and groups.ts). In memory, seeded with a few installed plugins
// so every screen has something to show; the catalog is a fixed list standing in for the live registries.
// Account connections (task P3): `/connect` signs in at once and redirects back, as after a real consent.
import * as NodeCrypto from "node:crypto";

const EVERYONE = "everyone";
const id = () => NodeCrypto.randomUUID();
const at = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();

/** What a registry search may return, with what installing it gives. */
const CATALOG = [
  {
    registry: "mcp",
    id: "com.notion/mcp",
    version: "1.2.0",
    name: "Notion",
    kind: "mcp",
    description: "Search, read and update pages and databases in your Notion workspace.",
    servers: [
      {
        name: "notion",
        url: "https://mcp.notion.com/mcp",
        credential: "user-oauth",
        personal: true,
      },
    ],
  },
  {
    registry: "mcp",
    id: "app.linear/mcp",
    version: "2.0.1",
    name: "Linear",
    kind: "mcp",
    description: "Find, create and update issues and projects in Linear.",
    servers: [
      {
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        credential: "user-oauth",
        personal: true,
      },
    ],
  },
  {
    registry: "mcp",
    id: "com.brave/search",
    version: "0.9.4",
    name: "Brave Search",
    kind: "mcp",
    description: "Web and news search through the Brave Search API.",
    servers: [
      {
        name: "brave-search",
        url: "https://mcp.search.brave.com/mcp",
        credential: "organization",
        personal: false,
      },
    ],
  },
  {
    registry: "mcp",
    id: "io.github/mcp",
    version: "1.0.0",
    name: "GitHub",
    kind: "mcp",
    description: "Read repositories, issues and pull requests.",
    servers: [
      {
        name: "github",
        url: "https://api.githubcopilot.com/mcp/",
        credential: "user-oauth",
        personal: true,
      },
    ],
  },
  {
    registry: "anthropic-knowledge-work",
    id: "sales",
    version: "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4",
    name: "Sales",
    kind: "bundle",
    description: "Prepare calls, research accounts and draft follow-ups, with your CRM connected.",
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
        personal: false,
      },
    ],
    ignored: [
      "commands/forecast.md (made for Claude Code)",
      "hooks/hooks.json (made for Claude Code)",
    ],
  },
  {
    registry: "anthropic-knowledge-work",
    id: "finance",
    version: "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4",
    name: "Finance",
    kind: "bundle",
    description: "Close the books, reconcile accounts and explain variances.",
    skills: [{ name: "month-end-close", description: "Walk through a month-end close checklist." }],
    ignored: ["servers/ledger (runs as a local program)"],
  },
  {
    registry: "anthropic-skills",
    id: "brand-guidelines",
    version: "c4ca4238a0b923820dcc509a6f75849bc81e728d",
    name: "Brand guidelines",
    kind: "skill",
    description: "Apply your brand's colours, fonts and tone to documents and slides.",
    skills: [{ name: "brand-guidelines", description: "Use the organization's visual identity." }],
  },
  {
    registry: "anthropic-skills",
    id: "internal-comms",
    version: "c4ca4238a0b923820dcc509a6f75849bc81e728d",
    name: "Internal comms",
    kind: "skill",
    description: "Write status reports, newsletters and announcements in a house style.",
    skills: [{ name: "internal-comms", description: "Draft internal communications." }],
  },
];

function pluginFrom(entry, overrides = {}) {
  return {
    id: id(),
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    source: { type: "registry", registry: entry.registry, id: entry.id, version: entry.version },
    skills: entry.skills ?? [],
    servers: (entry.servers ?? []).map((server) => ({ ...server, transport: "streamable-http" })),
    ignored: entry.ignored ?? [],
    enabled: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function createPluginMock({ users, spaces }) {
  /** @type {Map<string, any>} */
  const plugins = new Map();
  const seed = (registryId, overrides) => {
    const plugin = pluginFrom(
      CATALOG.find((entry) => entry.id === registryId),
      overrides,
    );
    plugins.set(plugin.id, plugin);
    return plugin.id;
  };
  const brave = seed("com.brave/search", { enabled: true, createdAt: at(5) });
  const sales = seed("sales", { createdAt: at(2) });
  const drive = {
    id: id(),
    kind: "mcp",
    name: "Google Drive",
    description: "Find and read the files people can open in their own Google Drive.",
    source: { type: "url", url: "https://drivemcp.googleapis.com/mcp/v1" },
    skills: [],
    servers: [
      {
        name: "drive",
        url: "https://drivemcp.googleapis.com/mcp/v1",
        credential: "login-identity",
        personal: true,
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
  /** user id -> plugin ids they turned on */
  const userEnabled = new Map([["u-bob", new Set([brave])]]);
  /** `${pluginId}\0${server}` with an organization key */
  const secrets = new Set([`${brave}\u0000brave-search`]);
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
  const connectionState = (plugin, server, userId) =>
    server.credential === "none"
      ? "not_required"
      : server.credential === "organization"
        ? secrets.has(`${plugin.id}\u0000${server.name}`)
          ? "configured"
          : "needs_configuration"
        : connected.has(connectionKey(userId, plugin.id, server.name))
          ? "connected"
          : "needs_connection";

  async function install(body) {
    const source = body.source ?? {};
    if (source.type === "registry") {
      const entry = CATALOG.find(
        (item) => item.registry === source.registry && item.id === source.id,
      );
      if (!entry) return [404, { error: "registry_plugin_not_found" }];
      return [201, pluginFrom(entry, body.name ? { name: body.name } : {})];
    }
    if (source.type === "url") {
      let url;
      try {
        url = new URL(String(source.url));
      } catch {
        return [400, { error: "invalid_mcp_url" }];
      }
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search)
        return [400, { error: "invalid_mcp_url" }];
      return [
        201,
        {
          id: id(),
          kind: "mcp",
          name: body.name || url.hostname,
          description: "",
          source: { type: "url", url: url.href },
          skills: [],
          servers: [
            {
              name: "remote",
              url: url.href,
              credential: "none",
              personal: false,
              transport: "streamable-http",
            },
          ],
          ignored: [],
          enabled: false,
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
      return [
        201,
        {
          id: id(),
          kind: "skill",
          name: body.name || folder || repo,
          description: "",
          source,
          skills: [{ name: folder || repo, description: "Imported from the repository." }],
          servers: [],
          ignored: [],
          enabled: false,
          createdAt: new Date().toISOString(),
        },
      ];
    }
    if (source.type === "archive") {
      const bytes = Buffer.from(String(body.archive ?? ""), "base64");
      if (!bytes.length) return [400, { error: "archive_required" }];
      if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== source.sha256)
        return [400, { error: "archive_hash_mismatch" }];
      return [
        201,
        {
          id: id(),
          kind: "skill",
          name: body.name || "Uploaded skill",
          description: "",
          source,
          skills: [{ name: "uploaded-skill", description: "From the uploaded file." }],
          servers: [],
          ignored: [],
          enabled: false,
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
    if (api.startsWith("/admin/plugins") || api.startsWith("/admin/groups")) {
      if (!isAdmin) return (fail(res, 403, "forbidden"), true);
    }
    if (api === "/admin/plugins/search" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const kind = url.searchParams.get("kind");
      // Shots exercise a registry that does not answer with a search containing "offline".
      const failures = q.includes("offline")
        ? [{ registry: "codex-plugins", error: "unavailable" }]
        : [];
      const results = CATALOG.filter(
        (entry) =>
          (!kind || entry.kind === kind) &&
          (!q ||
            `${entry.name} ${entry.description}`
              .toLowerCase()
              .includes(q.replace("offline", "").trim())),
      ).map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        kind: entry.kind,
        source: {
          type: "registry",
          registry: entry.registry,
          id: entry.id,
          version: entry.version,
        },
      }));
      return (send(res, 200, { results, failures }), true);
    }
    if (api === "/admin/plugins" && method === "GET")
      return (
        send(res, 200, {
          plugins: [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name)),
        }),
        true
      );
    if (api === "/admin/plugins" && method === "POST") {
      const [status, body] = await install(await readBody(req));
      if (status === 201) plugins.set(body.id, body);
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
        plugins.delete(plugin.id);
        for (const group of groups)
          group.plugins = group.plugins.filter((entry) => entry !== plugin.id);
        return (send(res, 200, { ok: true }), true);
      }
      if (method === "PATCH") {
        const { servers, ...fields } = await readBody(req);
        if (servers) {
          if (
            servers.some(
              (server) =>
                ["user-oauth", "login-identity"].includes(server.credential) && !server.personal,
            )
          )
            return (fail(res, 400, "personal_credential_required"), true);
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
      const mine = userEnabled.get(me.id) ?? new Set();
      return (
        send(res, 200, {
          plugins: [...plugins.values()]
            .filter((plugin) => allowed.has(plugin.id))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((plugin) => ({
              ...plugin,
              userEnabled: mine.has(plugin.id),
              connections: plugin.servers.map((server) => ({
                server: server.name,
                state: connectionState(plugin, server, me.id),
              })),
            })),
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
        connected.add(connectionKey(me.id, plugin.id, target.name));
        const back = new URL(url.searchParams.get("returnTo") ?? "/", url.origin);
        back.searchParams.set("pluginConnection", "connected");
        res.writeHead(302, { location: back.pathname + back.search });
        res.end();
        return true;
      }
    }
    if ((r = /^\/plugins\/([^/]+)\/enabled$/.exec(api)) && method === "PUT") {
      if (!grantsOf(me.id).plugins.has(r[1]) || !plugins.has(r[1]))
        return (fail(res, 404, "not_found"), true);
      const { enabled } = await readBody(req);
      const mine = userEnabled.get(me.id) ?? new Set();
      if (enabled) mine.add(r[1]);
      else mine.delete(r[1]);
      userEnabled.set(me.id, mine);
      return (send(res, 200, { enabled: Boolean(enabled) }), true);
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
