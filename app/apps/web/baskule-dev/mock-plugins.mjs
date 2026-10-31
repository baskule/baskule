// baskule: the plugins and groups part of the mock front (shapes: packages/contracts/src/baskule-plugins.ts,
// behaviour: platform/src/control/plugins.ts and groups.ts). In memory; catalog installs use the real list.
// `/connect` signs an account in at once, a vendor app is only remembered as saved, a package reads as a fixed
// draft to fix, the exported zip holds only plugin.json, and every server lists the same three tools.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import { catalogService, catalogVendor } from "../../../packages/contracts/src/baskule-catalog.ts";

const EVERYONE = "everyone";
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
      disabledTools: [],
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
    omitted: [],
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

/** A plugin an admin brought: a package, a GitHub folder or a server by its address. */
function ownPlugin(fields) {
  const pluginId = id();
  return {
    id: pluginId,
    vendor: pluginId,
    description: "",
    skills: [],
    servers: [],
    omitted: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

const skillInput = (skill) => ({ ...skill, instructions: `# ${skill.name}\n`, files: [] });
/** As `validateServer`: switched-off tools are stored once each. */
const savedServer = (server) => ({
  ...server,
  disabledTools: [...new Set(server.disabledTools ?? [])],
});
const toolsOf = (server) => [
  { name: "search", description: `Search ${new URL(server.url).hostname}.` },
  { name: "read_item", description: "Read one item." },
  { name: "delete_item", description: "Delete an item." },
];
const summary = (skill) => ({ name: skill.name, description: skill.description });
const placeholder = /\$?\{[^}]+\}/;

/** A zip with one stored file, enough for "Download as zip" to save something real. */
function zipOf(path, text) {
  const name = Buffer.from(path);
  const data = Buffer.from(text);
  const crc = NodeZlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12); // 1980-01-01, the earliest DOS date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
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
    source: { type: "custom" },
    servers: [
      {
        name: "brave-search",
        url: "https://mcp.search.brave.com/mcp",
        credential: "organization",
        transport: "streamable-http",
        disabledTools: [],
      },
    ],
    createdAt: at(5),
  });
  const sales = seed({
    name: "Sales",
    description: "Prepare calls, research accounts and draft follow-ups, with your CRM connected.",
    source: {
      type: "github",
      repo: "https://github.com/anthropics/knowledge-work-plugins",
      sha: "8f14e45fceea167a5a36dedd4bea2543a1b2c3d4",
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
        disabledTools: [],
      },
    ],
    omitted: [
      { code: "claude_commands", subject: "commands/forecast.md" },
      { code: "hooks", subject: "hooks/hooks.json" },
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
    source: { type: "custom" },
    skills: [],
    servers: [
      {
        name: "drive",
        url: "https://drivemcp.googleapis.com/mcp/v1",
        credential: "user-oauth",
        oauth: { staticClient: true },
        transport: "streamable-http",
        disabledTools: [],
      },
    ],
    omitted: [],
    enabled: true,
    createdAt: at(4),
  };
  plugins.set(drive.id, drive);
  /** Each plugin's skills in full, as `GET /admin/plugins/:id/skills` returns them. */
  const skillsOf = new Map(
    [...plugins.values()].map((plugin) => [plugin.id, plugin.skills.map(skillInput)]),
  );

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
  /** @type {Array<{id: string, userId: string, pluginId: string, server: string, label: string, default: boolean}>} */
  let accounts = [];
  const accountsOf = (userId, pluginId, server) =>
    accounts.filter(
      (entry) => entry.userId === userId && entry.pluginId === pluginId && entry.server === server,
    );
  const accountLabel = (value) => {
    const label = typeof value === "string" ? value.trim() : "";
    return label.length >= 1 && label.length <= 100 && !/\p{Cc}/u.test(label) ? label : null;
  };
  /** Whether the shared part of a server's sign-in is done: its organization key or its vendor's app. */
  const setupDone = (plugin, server) =>
    server.credential === "organization"
      ? secrets.has(`${plugin.id}\u0000${server.name}`)
      : server.credential !== "user-oauth" ||
        !server.oauth?.staticClient ||
        vendors.has(plugin.vendor);
  /** A server's status follows the person's default account. */
  const connectionState = (plugin, server, userId) =>
    !plugin.enabled
      ? "unavailable"
      : !setupDone(plugin, server)
        ? "needs_setup"
        : server.credential !== "user-oauth" ||
            accountsOf(userId, plugin.id, server.name).some((entry) => entry.default)
          ? "ready"
          : "connect";

  /** The server's checks on a `PluginInput`, short of the address policy. */
  function inputError(input) {
    if (!input || typeof input.name !== "string" || !input.name.trim())
      return "invalid_plugin_input";
    if (!["github", "upload", "custom"].includes(input.source?.type)) return "invalid_plugin_input";
    if (!Array.isArray(input.servers) || !Array.isArray(input.skills))
      return "invalid_plugin_input";
    if (input.servers.length === 0 && input.skills.length === 0) return "empty_plugin";
    for (const server of input.servers) {
      if (placeholder.test(String(server.url))) return "address_placeholder";
      try {
        if (new URL(String(server.url)).protocol !== "https:") return "address_not_allowed";
      } catch {
        return "address_not_allowed";
      }
    }
    return null;
  }

  function install(body) {
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
    const error = inputError(body.plugin);
    if (error) return [400, { error }];
    const { name, description, icon, source, servers, skills, omitted } = body.plugin;
    const plugin = ownPlugin({
      name: name.trim(),
      description: String(description ?? ""),
      ...(icon ? { icon } : {}),
      source,
      servers: servers.map(savedServer),
      skills: skills.map(summary),
      omitted: omitted ?? [],
    });
    skillsOf.set(plugin.id, skills);
    return [201, plugin];
  }

  /** What reading a package or GitHub link finds: a server to finish and parts left out. */
  function inspect(body) {
    if (typeof body.github === "string") {
      const match =
        /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(
          body.github.trim(),
        );
      if (!match) return [400, { error: "github_link_invalid" }];
      const folder = match[3]?.split("/").at(-1);
      const skillName = (folder ?? match[2]).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return [
        200,
        {
          plugin: {
            name: folder ?? match[2],
            description: "",
            source: {
              type: "github",
              repo: `https://github.com/${match[1]}/${match[2]}`,
              sha: NodeCrypto.createHash("sha1").update(body.github).digest("hex"),
              ...(match[3] ? { path: match[3] } : {}),
            },
            servers: [],
            skills: [skillInput({ name: skillName, description: "Imported from the repository." })],
            omitted: [],
          },
          fixes: [],
          omitted: [],
        },
      ];
    }
    const bytes = Buffer.from(String(body.archive ?? ""), "base64");
    if (!bytes.length) return [400, { error: "empty_plugin_archive" }];
    const omitted = [
      { code: "claude_commands", subject: "commands/forecast.md" },
      { code: "local_program", subject: "local-notes" },
    ];
    return [
      200,
      {
        plugin: {
          name: "Acme CRM",
          description: "Accounts, contacts and deals from Acme CRM.",
          source: {
            type: "upload",
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          },
          servers: [
            {
              name: "crm",
              url: "https://{tenant}.crm.example.com/mcp",
              credential: "organization",
              transport: "streamable-http",
            },
          ],
          skills: [
            skillInput({ name: "call-prep", description: "Prepare a sales call from the CRM." }),
          ],
          omitted,
        },
        fixes: [
          { server: "crm", need: "address", placeholders: ["{tenant}"] },
          { server: "crm", need: "key", headers: ["X-Api-Key"] },
        ],
        omitted,
      },
    ];
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
          if (
            typeof body?.clientId !== "string" ||
            !body.clientId ||
            !["none", "client_secret_post", "client_secret_basic"].includes(auth) ||
            (auth !== "none") !== Boolean(body.clientSecret)
          )
            return (fail(res, 400, "invalid_oauth_client"), true);
          vendors.add(vendor);
        } else vendors.delete(vendor);
        // Saving or removing an app disconnects every account of this vendor.
        accounts = accounts.filter(
          (entry) => !owned.some((plugin) => plugin.id === entry.pluginId),
        );
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
      const [status, body] = install(input);
      if (status === 201) {
        plugins.set(body.id, body);
        for (const group of groups)
          if (input.groups.includes(group.id)) group.plugins.push(body.id);
      }
      return (send(res, status, body), true);
    }
    if (api === "/admin/plugins/inspect" && method === "POST") {
      const [status, body] = inspect(await readBody(req));
      return (send(res, status, body), true);
    }
    // Tests a server that isn't saved: each person's sign-in, or a key that must be sent with it.
    if (api === "/admin/plugins/test" && method === "POST") {
      const { server, headers } = await readBody(req);
      const error = inputError({
        name: "test",
        source: { type: "custom" },
        servers: [server],
        skills: [],
      });
      if (error) return (fail(res, 400, error), true);
      if (server.credential === "user-oauth")
        return (send(res, 200, { signIn: "account", staticClient: false }), true);
      if (server.credential === "organization" && !Object.values(headers ?? {}).some(Boolean))
        return (fail(res, 409, "key_required"), true);
      return (send(res, 200, { tools: toolsOf(server) }), true);
    }
    if ((r = /^\/admin\/plugins\/([^/]+)(\/secret|\/skills|\/export|\/tools)?$/.exec(api))) {
      const plugin = plugins.get(r[1]);
      if (!plugin) return (fail(res, 404, "not_found"), true);
      // Every tool, switched off or not, through the saved key or the admin's own default account.
      if (r[2] === "/tools" && method === "GET") {
        const server = plugin.servers.find(
          (entry) => entry.name === url.searchParams.get("server"),
        );
        if (!server) return (fail(res, 400, "plugin_server_required"), true);
        if (server.credential === "organization" && !setupDone(plugin, server))
          return (fail(res, 409, "key_required"), true);
        if (
          server.credential === "user-oauth" &&
          !accountsOf(me.id, plugin.id, server.name).some((entry) => entry.default)
        )
          return (fail(res, 409, "connection_not_allowed"), true);
        return (send(res, 200, { tools: toolsOf(server) }), true);
      }
      if (r[2] === "/skills" && method === "GET")
        return (
          send(res, 200, {
            skills: skillsOf.get(plugin.id) ?? [],
            editable: plugin.source.type === "custom" || plugin.source.type === "upload",
          }),
          true
        );
      if (r[2] === "/export" && method === "GET") {
        if (plugin.source.type === "catalog") return (fail(res, 409, "not_editable"), true);
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="plugin.zip"',
          "cache-control": "no-store",
        });
        res.end(
          zipOf(
            ".claude-plugin/plugin.json",
            JSON.stringify({ name: plugin.name, description: plugin.description }, null, 2),
          ),
        );
        return true;
      }
      if (r[2] === "/secret" && method === "PUT") {
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
        accounts = accounts.filter((entry) => entry.pluginId !== plugin.id);
        for (const group of groups)
          group.plugins = group.plugins.filter((entry) => entry !== plugin.id);
        return (send(res, 200, { ok: true }), true);
      }
      if (r[2] === undefined && method === "PATCH") {
        const patch = await readBody(req);
        if (typeof patch.enabled === "boolean" && Object.keys(patch).length === 1) {
          plugin.enabled = patch.enabled;
          return (send(res, 200, plugin), true);
        }
        // Only the servers named change their switches.
        if (patch.disabledTools && Object.keys(patch).length === 1) {
          const names = Object.keys(patch.disabledTools);
          if (names.some((name) => !plugin.servers.some((server) => server.name === name)))
            return (fail(res, 400, "plugin_server_required"), true);
          plugin.servers = plugin.servers.map((server) =>
            names.includes(server.name)
              ? savedServer({ ...server, disabledTools: patch.disabledTools[server.name] })
              : server,
          );
          return (send(res, 200, plugin), true);
        }
        const input = patch.plugin;
        if (
          plugin.source.type === "catalog" ||
          JSON.stringify(plugin.source) !== JSON.stringify(input?.source) ||
          (plugin.source.type === "github" &&
            JSON.stringify(input.skills) !== JSON.stringify(skillsOf.get(plugin.id)))
        )
          return (fail(res, 409, "not_editable"), true);
        const error = inputError(input);
        if (error) return (fail(res, 400, error), true);
        for (const server of plugin.servers) {
          const next = input.servers.find((entry) => entry.name === server.name);
          if (next?.credential !== "organization" || next.url !== server.url)
            secrets.delete(`${plugin.id}\u0000${server.name}`);
        }
        Object.assign(plugin, {
          name: input.name.trim(),
          description: String(input.description ?? ""),
          ...(input.icon ? { icon: input.icon } : {}),
          servers: input.servers.map(savedServer),
          skills: input.skills.map(summary),
          omitted: input.omitted ?? [],
        });
        if (!input.icon) delete plugin.icon;
        skillsOf.set(plugin.id, input.skills);
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
                accounts:
                  server.credential === "user-oauth"
                    ? accountsOf(me.id, plugin.id, server.name)
                        .toSorted((a, b) => Number(b.default) - Number(a.default))
                        .map((entry) => ({
                          id: entry.id,
                          label: entry.label,
                          default: entry.default,
                          status: "ready",
                        }))
                    : [],
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
    if ((r = /^\/plugins\/([^/]+)\/connect$/.exec(api)) && method === "GET") {
      const plugin = plugins.get(r[1]);
      if (!plugin || !grantsOf(me.id).plugins.has(r[1])) return (fail(res, 404, "not_found"), true);
      const target = plugin.servers.find(
        (s) => s.name === url.searchParams.get("server") && s.credential === "user-oauth",
      );
      if (!target) return (fail(res, 400, "plugin_server_required"), true);
      const own = accountsOf(me.id, plugin.id, target.name);
      const reconnect = url.searchParams.get("account");
      const label = accountLabel(url.searchParams.get("label") ?? plugin.name.slice(0, 100));
      const back = new URL(url.searchParams.get("returnTo") ?? "/", url.origin);
      // A refused start comes back like a failed sign-in.
      const error =
        reconnect !== null && url.searchParams.has("label")
          ? "invalid_plugin_input"
          : reconnect !== null && !own.some((entry) => entry.id === reconnect)
            ? "account_not_found"
            : reconnect === null && !label
              ? "invalid_plugin_input"
              : reconnect === null && own.some((entry) => entry.label === label)
                ? "account_label_taken"
                : !setupDone(plugin, target)
                  ? "oauth_client_configuration_required"
                  : null;
      if (error) {
        back.searchParams.set("pluginConnection", "error");
        back.searchParams.set("connectionError", error);
      } else {
        // Reconnecting keeps the account's id, name and default.
        if (reconnect === null)
          accounts.push({
            id: id(),
            userId: me.id,
            pluginId: plugin.id,
            server: target.name,
            label,
            default: own.length === 0,
          });
        back.searchParams.set("pluginConnection", "connected");
      }
      res.writeHead(302, { location: back.pathname + back.search });
      res.end();
      return true;
    }
    if ((r = /^\/plugins\/([^/]+)\/accounts\/([^/]+)$/.exec(api))) {
      if (!plugins.has(r[1]) || !grantsOf(me.id).plugins.has(r[1]))
        return (fail(res, 404, "not_found"), true);
      const owned = accounts.find(
        (entry) => entry.id === r[2] && entry.userId === me.id && entry.pluginId === r[1],
      );
      if (!owned) return (fail(res, 404, "account_not_found"), true);
      const siblings = accountsOf(me.id, owned.pluginId, owned.server).filter(
        (entry) => entry !== owned,
      );
      if (method === "PATCH") {
        const body = await readBody(req);
        const label = body?.label === undefined ? undefined : accountLabel(body.label);
        if (
          label === null ||
          (body?.default !== undefined && body.default !== true) ||
          (label === undefined && body?.default === undefined)
        )
          return (fail(res, 400, "invalid_plugin_input"), true);
        if (label !== undefined && siblings.some((entry) => entry.label === label))
          return (fail(res, 409, "account_label_taken"), true);
        if (label !== undefined) owned.label = label;
        if (body.default) {
          for (const entry of siblings) entry.default = false;
          owned.default = true;
        }
        return (send(res, 200, { ok: true }), true);
      }
      if (method === "DELETE") {
        const replacement = siblings.find((entry) => entry.id === url.searchParams.get("default"));
        if (owned.default && siblings.length > 0 && !replacement)
          return (fail(res, 409, "default_account_required"), true);
        accounts = accounts.filter((entry) => entry !== owned);
        if (owned.default && replacement) replacement.default = true;
        return (send(res, 200, { ok: true }), true);
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
