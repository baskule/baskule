// baskule: the plugins and groups part of the mock front (shapes: packages/contracts/src/baskule-plugins.ts).
// In memory. The catalog is plugin-catalog.json, real Cursor, xAI and app platform entries recorded once with
// what a preview of each finds. Sign-in comes back at once as the member's email, and app platforms accept any
// credentials except the API key "bad".
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { ISSUER_DEFAULT_PARAMS } from "../../../packages/contracts/src/baskule-plugins.ts";

const EVERYONE = "everyone";
const FIXTURE = JSON.parse(
  NodeFS.readFileSync(new URL("./plugin-catalog.json", import.meta.url), "utf8"),
);
const at = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const digestOf = (value) =>
  `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "plugin";
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** What `POST /admin/plugins/preview` finds for a reference, or an error code. */
function previewOf(ref) {
  if (ref?.kind === "catalog") {
    const recorded = FIXTURE.find((item) => item.entry.id === ref.entryId);
    if (!recorded) return { error: "plugin_not_found", status: 404 };
    const { entry, preview } = recorded;
    return {
      preview: {
        name: entry.name,
        displayName: entry.displayName,
        description: entry.description,
        logo: entry.logo,
        homepage: entry.homepage,
        category: entry.category,
        origin: preview.origin,
        digest: digestOf(recorded),
        servers: preview.servers,
        skills: preview.skills,
        skipped: preview.skipped,
      },
    };
  }
  if (ref?.kind === "github") {
    const match =
      /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(
        String(ref.url ?? "").trim(),
      );
    if (!match) return { error: "source_not_github", status: 400 };
    const [, owner, repo, path] = match;
    const name = slug(path?.split("/").at(-1) ?? repo);
    const origin = {
      kind: "github",
      repo: `https://github.com/${owner}/${repo}`,
      ...(path ? { path } : {}),
      sha: NodeCrypto.createHash("sha1").update(ref.url).digest("hex"),
    };
    const preview = {
      name,
      displayName: name.replace(
        /(^|-)(\w)/g,
        (_, dash, letter) => `${dash ? " " : ""}${letter.toUpperCase()}`,
      ),
      description: `Skills from ${owner}/${repo}.`,
      logo: null,
      homepage: origin.repo,
      category: null,
      origin,
      servers: [],
      skills: [
        { name: `${name}-guide`, description: "How the team works with this tool.", files: 2 },
      ],
      skipped: [{ kind: "editor_only", subject: "hooks/hooks.json" }],
    };
    return { preview: { ...preview, digest: digestOf(preview) } };
  }
  if (ref?.kind === "custom") {
    const server = ref.server ?? {};
    let url;
    try {
      url = new URL(String(server.url));
    } catch {
      return { error: "invalid_server", status: 400 };
    }
    if (url.protocol !== "https:" || !String(server.displayName ?? "").trim())
      return { error: "invalid_server", status: 400 };
    const header = server.auth === "header" ? String(server.headerName ?? "").trim() : "";
    if (server.auth === "header" && !header) return { error: "invalid_request", status: 400 };
    const auth =
      server.auth === "none"
        ? { kind: "none" }
        : server.auth === "header"
          ? { kind: "headers", headers: [header] }
          : url.hostname.endsWith(".googleapis.com")
            ? { kind: "oauth", issuer: "https://accounts.google.com", registration: "client" }
            : { kind: "oauth", issuer: url.origin, registration: "dynamic" };
    const name = slug(server.displayName);
    const preview = {
      name,
      displayName: String(server.displayName).trim(),
      description: String(server.description ?? "").trim(),
      logo: null,
      homepage: url.origin,
      category: null,
      origin: { kind: "custom" },
      servers: [
        {
          name,
          url: url.href,
          transport: "streamable-http",
          auth,
          variables: header ? [{ name: header, secret: true, where: "header" }] : [],
        },
      ],
      skills: [],
      skipped: [],
    };
    return { preview: { ...preview, digest: digestOf(preview) } };
  }
  return { error: "invalid_request", status: 400 };
}

export function createPluginMock({ users }) {
  /** @type {Map<string, any>} */
  const plugins = new Map();
  /** issuer -> { clientId, clientSecret, scopes, authorizationParams } */
  const oauthClients = new Map();
  const providers = {
    composio: { configured: true },
    pipedream: { configured: false, projectId: null, environment: null },
  };
  /** `${userId}\0${pluginId}` switched off */
  const switchedOff = new Set();
  /** `${userId}\0${pluginId}\0${serverId}` -> { account, connectedAt, expired } */
  const connections = new Map();

  /** @type {Array<{id: string, name: string, builtin?: "everyone", members: string[], permissions: {canCreateSpaces: boolean}}>} */
  const groups = [
    {
      id: EVERYONE,
      name: "Everyone",
      builtin: "everyone",
      members: [],
      permissions: { canCreateSpaces: false },
    },
    { id: "g-sales", name: "Sales", members: ["u-alice"], permissions: { canCreateSpaces: true } },
    {
      id: "g-support",
      name: "Support",
      members: ["u-bob"],
      permissions: { canCreateSpaces: false },
    },
  ];
  const listGroups = () =>
    groups.map((group) => ({
      ...group,
      members: group.builtin
        ? [...users.keys()].sort()
        : group.members.filter((member) => users.has(member)),
    }));

  const install = (
    preview,
    { access = { kind: "everyone" }, values = {}, by = "u-admin", daysAgo = 0 } = {},
  ) => {
    let id = preview.name;
    for (let n = 2; plugins.has(id); n++) id = `${preview.name}-${n}`;
    const plugin = {
      id,
      name: preview.name,
      displayName: preview.displayName,
      description: preview.description,
      logo: preview.logo,
      homepage: preview.homepage,
      category: preview.category,
      origin: preview.origin,
      enabled: true,
      access,
      values,
      servers: preview.servers.map((server) => ({ ...server, id: slug(server.name) })),
      skills: preview.skills.map(({ name, description }) => ({ name, description })),
      installedAt: at(daysAgo),
      installedBy: by,
    };
    plugins.set(id, plugin);
    return plugin;
  };
  const seed = (entryId, options) =>
    install(previewOf({ kind: "catalog", entryId }).preview, options);
  // Gmail waits for its Google OAuth client; Intercom and Linear work, and Alice signed in to Intercom.
  seed("cursor:https://github.com/cursor/plugins#third_party/gmail", { daysAgo: 1 });
  const intercom = seed("cursor:https://github.com/cursor/plugins#third_party/intercom", {
    access: { kind: "groups", groups: ["g-sales", "g-support"] },
    daysAgo: 6,
  });
  seed("composio:linear", { daysAgo: 3 });
  connections.set(`u-alice\u0000${intercom.id}\u0000intercom`, {
    account: "alice@baskule.test",
    connectedAt: at(5),
    expired: false,
  });

  const memberOf = (userId, plugin) =>
    plugin.access.kind === "everyone" ||
    listGroups().some(
      (group) => plugin.access.groups.includes(group.id) && group.members.includes(userId),
    );
  const serverSetup = (plugin, server) => {
    const values = plugin.values[server.name] ?? {};
    const missing = server.variables.filter((variable) => !values[variable.name]);
    if (missing.length > 0)
      return { state: "needs_values", variables: missing.map((variable) => variable.name) };
    const { auth } = server;
    if (
      auth.kind === "oauth" &&
      auth.registration === "client" &&
      auth.issuer &&
      !oauthClients.has(auth.issuer)
    )
      return { state: "needs_oauth_client", issuer: auth.issuer };
    if (auth.kind === "provider" && !providers[auth.provider].configured)
      return { state: "needs_provider", provider: auth.provider };
    return { state: "ready" };
  };
  const connectionKey = (userId, plugin, server) => `${userId}\u0000${plugin.id}\u0000${server.id}`;
  const memberConnection = (userId, plugin, server) => {
    if (serverSetup(plugin, server).state !== "ready") return { state: "unavailable" };
    if (server.auth.kind === "none" || server.auth.kind === "headers")
      return { state: "not_required" };
    const connection = connections.get(connectionKey(userId, plugin, server));
    if (!connection) return { state: "not_connected" };
    return connection.expired
      ? { state: "expired" }
      : { state: "connected", account: connection.account, connectedAt: connection.connectedAt };
  };
  const adminPlugin = (plugin) => {
    const servers = plugin.servers.map((server) => ({
      id: server.id,
      name: server.name,
      url: server.url,
      auth: server.auth,
      variables: server.variables.map((variable) => ({
        ...variable,
        set: Boolean(plugin.values[server.name]?.[variable.name]),
      })),
      setup: serverSetup(plugin, server),
      connectedMembers: [...connections.keys()].filter((key) =>
        key.endsWith(`\u0000${plugin.id}\u0000${server.id}`),
      ).length,
    }));
    const { values: _values, ...shown } = plugin;
    return {
      ...shown,
      servers,
      status: !plugin.enabled
        ? "paused"
        : servers.some((server) => server.setup.state !== "ready")
          ? "needs_setup"
          : "ready",
    };
  };
  const callbackUrl = (url) => `${url.origin}/api/baskule/plugins/oauth/callback`;
  const oauthClientList = (url) => {
    const issuers = new Set(oauthClients.keys());
    for (const plugin of plugins.values())
      for (const server of plugin.servers)
        if (
          server.auth.kind === "oauth" &&
          server.auth.registration === "client" &&
          server.auth.issuer
        )
          issuers.add(server.auth.issuer);
    return [...issuers].sort().map((issuer) => {
      const client = oauthClients.get(issuer);
      const using = [...plugins.values()].filter((plugin) =>
        plugin.servers.some(
          (server) => server.auth.kind === "oauth" && server.auth.issuer === issuer,
        ),
      );
      return {
        issuer,
        configured: Boolean(client),
        clientId: client?.clientId ?? null,
        hasSecret: Boolean(client?.clientSecret),
        scopes: client?.scopes ?? null,
        authorizationParams: client?.authorizationParams ?? null,
        callbackUrl: callbackUrl(url),
        hosts: [
          ...new Set(
            using.flatMap((plugin) =>
              plugin.servers
                .filter((server) => server.auth.kind === "oauth" && server.auth.issuer === issuer)
                .map((server) => hostOf(server.url)),
            ),
          ),
        ],
        usedBy: using.map((plugin) => ({ pluginId: plugin.id, displayName: plugin.displayName })),
      };
    });
  };
  const catalog = () => {
    const installedFrom = (entry) =>
      [...plugins.values()].find((plugin) =>
        entry.source === "composio" || entry.source === "pipedream"
          ? plugin.origin.kind === "provider" && plugin.origin.app === entry.name
          : plugin.origin.kind === "registry" &&
            `${plugin.origin.registry}:${plugin.origin.repo}#${plugin.origin.path ?? ""}` ===
              entry.id,
      )?.id ?? null;
    const entries = FIXTURE.map((item) => item.entry)
      .filter((entry) => !(entry.source in providers) || providers[entry.source].configured)
      .map((entry) => ({ ...entry, installedPluginId: installedFrom(entry) }))
      .toSorted(
        (a, b) =>
          Number(b.recommended) - Number(a.recommended) ||
          Number(Boolean(b.logo)) - Number(Boolean(a.logo)) ||
          a.displayName.localeCompare(b.displayName),
      );
    return {
      entries,
      unavailable: [],
      refreshedAt: at(0.01),
      providers: {
        composio: providers.composio.configured,
        pipedream: providers.pipedream.configured,
      },
    };
  };
  const validAccess = (access) =>
    access?.kind === "everyone" ||
    (access?.kind === "groups" &&
      Array.isArray(access.groups) &&
      access.groups.every((id) => groups.some((group) => group.id === id)));
  /** Values merge per variable; an empty value keeps the saved one. */
  const mergeValues = (plugin, values) => {
    for (const [server, entries] of Object.entries(values ?? {})) {
      if (!plugin.servers.some((candidate) => candidate.name === server)) return false;
      for (const [name, value] of Object.entries(entries))
        if (typeof value === "string" && value.trim())
          plugin.values[server] = { ...plugin.values[server], [name]: value.trim() };
    }
    return true;
  };

  async function handle({ req, res, url, api, me, isAdmin, send, fail, readBody }) {
    const method = req.method ?? "GET";
    let r;
    if (/^\/admin\/(plugins|groups|catalog|oauth-clients|plugin-providers)/.test(api) && !isAdmin)
      return (fail(res, 403, "forbidden"), true);

    if (api === "/admin/catalog" && method === "GET") return (send(res, 200, catalog()), true);
    if (api === "/admin/plugins" && method === "GET")
      return (
        send(res, 200, {
          plugins: [...plugins.values()]
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map(adminPlugin),
          oauthClients: oauthClientList(url),
          providers,
        }),
        true
      );
    if (api === "/admin/plugins/preview" && method === "POST") {
      const found = previewOf((await readBody(req)).ref);
      return (
        found.error ? fail(res, found.status, found.error) : send(res, 200, found.preview), true
      );
    }
    if (api === "/admin/plugins" && method === "POST") {
      const body = await readBody(req);
      const found = previewOf(body.ref);
      if (found.error) return (fail(res, found.status, found.error), true);
      if (found.preview.digest !== body.digest) return (fail(res, 409, "plugin_changed"), true);
      if (!validAccess(body.access)) return (fail(res, 400, "group_not_found"), true);
      if (
        body.ref.kind === "catalog" &&
        catalog().entries.find((entry) => entry.id === body.ref.entryId)?.installedPluginId
      )
        return (fail(res, 409, "plugin_exists"), true);
      const plugin = install(found.preview, { access: body.access, by: me.id });
      if (!mergeValues(plugin, body.values)) {
        plugins.delete(plugin.id);
        return (fail(res, 400, "invalid_request"), true);
      }
      return (send(res, 201, adminPlugin(plugin)), true);
    }
    if ((r = /^\/admin\/plugins\/([^/]+)$/.exec(api))) {
      const plugin = plugins.get(decodeURIComponent(r[1]));
      if (!plugin) return (fail(res, 404, "plugin_not_found"), true);
      if (method === "DELETE") {
        plugins.delete(plugin.id);
        for (const key of [...connections.keys()])
          if (key.includes(`\u0000${plugin.id}\u0000`)) connections.delete(key);
        return (send(res, 200, { ok: true }), true);
      }
      if (method === "PATCH") {
        const body = await readBody(req);
        if (body.access !== undefined && !validAccess(body.access))
          return (fail(res, 400, "group_not_found"), true);
        if (body.enabled !== undefined) plugin.enabled = Boolean(body.enabled);
        if (body.access !== undefined) plugin.access = body.access;
        if (body.values !== undefined && !mergeValues(plugin, body.values))
          return (fail(res, 400, "server_not_found"), true);
        return (send(res, 200, adminPlugin(plugin)), true);
      }
    }
    if (api === "/admin/oauth-clients" && method === "PUT") {
      const body = await readBody(req);
      const clientId = String(body.clientId ?? "").trim();
      if (!body.issuer || !clientId) return (fail(res, 400, "invalid_oauth_client"), true);
      const previous = oauthClients.get(body.issuer);
      oauthClients.set(body.issuer, {
        clientId,
        clientSecret: body.clientSecret?.trim() || previous?.clientSecret || null,
        scopes: body.scopes?.trim() || null,
        authorizationParams:
          body.authorizationParams?.trim() || ISSUER_DEFAULT_PARAMS[body.issuer] || null,
      });
      return (
        send(
          res,
          200,
          oauthClientList(url).find((entry) => entry.issuer === body.issuer),
        ),
        true
      );
    }
    if ((r = /^\/admin\/plugin-providers\/(composio|pipedream)$/.exec(api))) {
      const provider = r[1];
      if (method === "DELETE") {
        providers[provider] =
          provider === "composio"
            ? { configured: false }
            : { configured: false, projectId: null, environment: null };
        return (send(res, 200, providers), true);
      }
      if (method === "PUT") {
        const body = await readBody(req);
        if (provider === "composio") {
          if (!String(body.apiKey ?? "").trim()) return (fail(res, 400, "invalid_request"), true);
          if (body.apiKey === "bad") return (fail(res, 400, "provider_rejected"), true);
          providers.composio = { configured: true };
        } else {
          if (!body.clientId || !body.clientSecret || !body.projectId)
            return (fail(res, 400, "invalid_request"), true);
          providers.pipedream = {
            configured: true,
            projectId: String(body.projectId),
            environment: body.environment === "development" ? "development" : "production",
          };
        }
        return (send(res, 200, providers), true);
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
        for (const plugin of plugins.values())
          if (plugin.access.kind === "groups")
            plugin.access = {
              kind: "groups",
              groups: plugin.access.groups.filter((id) => id !== current.id),
            };
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
          id: NodeCrypto.randomUUID(),
          name,
          members: [],
          permissions: { canCreateSpaces: false },
        };
        next.name = name;
        if (body.members) next.members = [...new Set(body.members)];
        if (body.permissions)
          next.permissions = { canCreateSpaces: Boolean(body.permissions.canCreateSpaces) };
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

    const mine = (pluginId) => {
      const plugin = plugins.get(decodeURIComponent(pluginId));
      return plugin && memberOf(me.id, plugin) ? plugin : null;
    };
    if (api === "/plugins" && method === "GET")
      return (
        send(res, 200, {
          plugins: [...plugins.values()]
            .filter((plugin) => memberOf(me.id, plugin))
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map((plugin) => ({
              id: plugin.id,
              displayName: plugin.displayName,
              description: plugin.description,
              logo: plugin.logo,
              category: plugin.category,
              on: !switchedOff.has(`${me.id}\u0000${plugin.id}`),
              enabled: plugin.enabled,
              servers: plugin.servers.map((server) => ({
                id: server.id,
                name: server.name,
                connection: memberConnection(me.id, plugin, server),
              })),
              skillCount: plugin.skills.length,
            })),
        }),
        true
      );
    if ((r = /^\/plugins\/([^/]+)$/.exec(api)) && method === "PUT") {
      const plugin = mine(r[1]);
      if (!plugin) return (fail(res, 404, "plugin_not_found"), true);
      const body = await readBody(req);
      if (typeof body.on !== "boolean") return (fail(res, 400, "invalid_request"), true);
      const key = `${me.id}\u0000${plugin.id}`;
      if (body.on) switchedOff.delete(key);
      else switchedOff.add(key);
      return (send(res, 200, { ok: true }), true);
    }
    if ((r = /^\/plugins\/([^/]+)\/servers\/([^/]+)\/(connect|connection)$/.exec(api))) {
      const plugin = mine(r[1]);
      const server = plugin?.servers.find((entry) => entry.id === decodeURIComponent(r[2]));
      if (!plugin || !server) return (fail(res, 404, "server_not_found"), true);
      if (r[3] === "connection" && method === "DELETE") {
        connections.delete(connectionKey(me.id, plugin, server));
        return (send(res, 200, { ok: true }), true);
      }
      if (r[3] === "connect" && method === "GET") {
        const back = new URL(url.searchParams.get("returnTo") || "/settings/plugins", url.origin);
        if (back.origin !== url.origin) return (fail(res, 400, "invalid_request"), true);
        back.searchParams.set("plugin", plugin.id);
        const setup = serverSetup(plugin, server);
        if (!plugin.enabled || setup.state !== "ready") {
          back.searchParams.set("connection", "error");
          back.searchParams.set(
            "code",
            setup.state === "needs_oauth_client" ? "oauth_client_required" : "setup_incomplete",
          );
        } else {
          connections.set(connectionKey(me.id, plugin, server), {
            account: users.get(me.id)?.email ?? null,
            connectedAt: new Date().toISOString(),
            expired: false,
          });
          back.searchParams.set("connection", "connected");
        }
        res.writeHead(302, { location: back.pathname + back.search });
        res.end();
        return true;
      }
    }
    return false;
  }

  return {
    handle,
    canCreateSpaces: (user) =>
      user.role === "admin" ||
      listGroups().some(
        (group) =>
          (group.builtin || group.members.includes(user.id)) && group.permissions.canCreateSpaces,
      ),
  };
}
