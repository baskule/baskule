// baskule: the plugin screens against a fake ControlCell (fetch): what an admin adds and for whom,
// the sign-in setup of a service without automatic registration, and a member's switch and sign-in.
import type { Group } from "@t3tools/contracts/baskule";
import type {
  AdminPlugin,
  AdminPluginList,
  Catalog,
  CatalogEntry,
  MemberPlugin,
  OAuthClientSetup,
  PluginPreview,
} from "@t3tools/contracts/baskule-plugins";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../../test/render";
import { toastManager } from "../../components/ui/toast";
import { AdminLayout } from "../admin/AdminShell";
import { AddPluginPage } from "../admin/plugins/AddPluginPage";
import { PluginPage } from "../admin/plugins/PluginPage";
import type { BaskuleMe } from "../api";
import { __setBaskuleMeForTests, readBaskuleMe } from "../session";
import { MemberPluginsView } from "./MemberPluginsView";

type Route = (body: unknown, query: URLSearchParams) => unknown;

// Browser tests run without the app's CSS: switches and dialog layers are not hit-testable, so
// clicks go through the DOM.
const press = (target: Locator) => act(() => (target.element() as HTMLElement).click());

/** A fetch answering `METHOD /path` from `routes`, recording each call. */
function fakeControl(routes: Record<string, Route>) {
  const calls: Array<{ readonly route: string; readonly body: unknown }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test");
    const route = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ route, body });
    const handler = routes[route];
    if (!handler) return Response.json({ error: "not_found" }, { status: 404 });
    const answer = await handler(body, url.searchParams);
    return answer instanceof Response ? answer : Response.json(answer);
  });
  return { calls, stub: stubGlobal("fetch", fetch) };
}

const bodyOf = (calls: ReadonlyArray<{ route: string; body: unknown }>, route: string) =>
  calls.find((call) => call.route === route)?.body;

const groups: Group[] = [
  {
    id: "everyone",
    name: "Everyone",
    builtin: "everyone",
    members: [],
    permissions: { canCreateSpaces: false },
  },
  { id: "sales", name: "Sales", members: ["u1", "u2"], permissions: { canCreateSpaces: false } },
  { id: "support", name: "Support", members: ["u3"], permissions: { canCreateSpaces: false } },
];

const GOOGLE = "https://accounts.google.com";
const CALLBACK = "https://baskule.example/api/baskule/plugins/oauth/callback";

function adminList(overrides: Partial<AdminPluginList> = {}): AdminPluginList {
  return {
    plugins: [],
    oauthClients: [],
    providers: {
      composio: { configured: false },
      pipedream: { configured: false, projectId: null, environment: null },
    },
    ...overrides,
  };
}

describe("adding a plugin", () => {
  const entryId = "cursor:https://github.com/cursor/plugins#third_party/netsuite";
  const entry: CatalogEntry = {
    id: entryId,
    source: "cursor",
    name: "netsuite",
    displayName: "NetSuite",
    description: "Work with records and reports in NetSuite.",
    logo: null,
    homepage: null,
    domains: [],
    keywords: [],
    category: "finance",
    recommended: false,
    hasServers: true,
    skillCount: 1,
    installedPluginId: null,
  };
  const catalog: Catalog = {
    entries: [entry],
    unavailable: [],
    refreshedAt: "2026-11-12T08:00:00Z",
    providers: { composio: false, pipedream: false },
  };
  const preview: PluginPreview = {
    name: "netsuite",
    displayName: "NetSuite",
    description: entry.description,
    logo: null,
    homepage: null,
    category: "finance",
    origin: {
      kind: "registry",
      registry: "cursor",
      repo: "https://github.com/cursor/plugins",
      path: "third_party/netsuite",
      sha: "2eaf46574b25cdf7ef8c849837099b866b7438ce",
    },
    digest: "sha256:netsuite",
    servers: [
      {
        name: "netsuite",
        url: "${NETSUITE_MCP_URL}",
        transport: "streamable-http",
        auth: { kind: "oauth", issuer: GOOGLE, registration: "client" },
        variables: [{ name: "NETSUITE_MCP_URL", secret: false, where: "url" }],
      },
    ],
    skills: [{ name: "suiteql", description: "Write SuiteQL queries.", files: 1 }],
    skipped: [{ kind: "local_program", subject: "netsuite-cli" }],
  };

  it("sends the reviewed digest, the chosen groups and the values it needs", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/catalog": () => catalog,
      "POST /api/baskule/admin/plugins/preview": () => preview,
      "GET /api/baskule/admin/plugins": () => adminList(),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins": () => ({ id: "netsuite", displayName: "NetSuite" }),
    });
    using _fetch = control.stub;
    await using screen = await render(<AddPluginPage id={entryId} />);

    const add = screen.getByRole("button", { name: "Add plugin" });
    await expect.element(add).toBeEnabled();
    expect(bodyOf(control.calls, "POST /api/baskule/admin/plugins/preview")).toEqual({
      ref: { kind: "catalog", entryId },
    });
    // A Google client is set up separately; adding without one leaves the plugin waiting for it.
    await expect
      .element(screen.getByRole("form", { name: "Set up sign-in to Google" }))
      .toBeVisible();
    await expect.element(screen.getByText(/Not added: netsuite-cli/)).toBeVisible();
    await press(screen.getByRole("radio", { name: "Only people in some groups" }));
    expect(screen.getByRole("checkbox", { name: "Everyone" }).query()).toBeNull();
    await press(screen.getByRole("checkbox", { name: /Support/ }));
    await userEvent.fill(
      screen.getByLabelText("NETSUITE_MCP_URL"),
      "https://acme.suitetalk.api.netsuite.com/mcp",
    );
    await press(add);

    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/admin/plugins/installed/netsuite"),
    );
    expect(bodyOf(control.calls, "POST /api/baskule/admin/plugins")).toEqual({
      ref: { kind: "catalog", entryId },
      digest: "sha256:netsuite",
      access: { kind: "groups", groups: ["support"] },
      values: { netsuite: { NETSUITE_MCP_URL: "https://acme.suitetalk.api.netsuite.com/mcp" } },
    });
  });

  it("reviews the plugin again when its source changed since it was read", async () => {
    let digest = "sha256:old";
    const control = fakeControl({
      "GET /api/baskule/admin/catalog": () => catalog,
      "POST /api/baskule/admin/plugins/preview": () => ({ ...preview, digest }),
      "GET /api/baskule/admin/plugins": () => adminList(),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins": () => {
        digest = "sha256:new";
        return Response.json({ error: "plugin_changed" }, { status: 409 });
      },
    });
    using _fetch = control.stub;
    await using screen = await render(<AddPluginPage id={entryId} />);

    const add = screen.getByRole("button", { name: "Add plugin" });
    await expect.element(add).toBeEnabled();
    await press(add);
    await expect
      .element(screen.getByText(/The plugin changed at its source since you opened it/))
      .toBeVisible();
    // Adding waits for the second review, so it sends the digest of what the admin now sees.
    await expect.element(add).toBeEnabled();
    expect(
      control.calls.filter((call) => call.route === "POST /api/baskule/admin/plugins/preview"),
    ).toHaveLength(2);
    await press(add);
    await vi.waitFor(() =>
      expect(
        control.calls
          .filter((call) => call.route === "POST /api/baskule/admin/plugins")
          .map((call) => (call.body as { digest: string }).digest),
      ).toEqual(["sha256:old", "sha256:new"]),
    );
  });
});

describe("signing in to a service without automatic registration", () => {
  const gmail: AdminPlugin = {
    id: "gmail",
    name: "gmail",
    displayName: "Gmail",
    description: "Search, read and draft email.",
    logo: null,
    homepage: null,
    category: "communication",
    origin: { kind: "custom" },
    enabled: true,
    access: { kind: "everyone" },
    servers: [
      {
        id: "gmail",
        name: "gmail",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        auth: { kind: "oauth", issuer: GOOGLE, registration: "client" },
        variables: [],
        setup: { state: "needs_oauth_client", issuer: GOOGLE },
        connectedMembers: 0,
      },
    ],
    skills: [],
    installedAt: "2026-11-12T08:00:00Z",
    installedBy: "u-admin",
    status: "needs_setup",
  };
  const google: OAuthClientSetup = {
    issuer: GOOGLE,
    configured: false,
    clientId: null,
    hasSecret: false,
    scopes: null,
    authorizationParams: null,
    callbackUrl: CALLBACK,
    hosts: ["gmailmcp.googleapis.com"],
    usedBy: [{ pluginId: "gmail", displayName: "Gmail" }],
  };

  it("shows the callback URL first and saves the client with Google's default parameters", async () => {
    let configured = false;
    const control = fakeControl({
      "GET /api/baskule/admin/plugins": () =>
        configured
          ? adminList({
              plugins: [
                {
                  ...gmail,
                  status: "ready",
                  servers: gmail.servers.map((server) => ({
                    ...server,
                    setup: { state: "ready" },
                  })),
                },
              ],
              oauthClients: [{ ...google, configured: true, clientId: "id-1", hasSecret: true }],
            })
          : adminList({ plugins: [gmail], oauthClients: [google] }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "PUT /api/baskule/admin/oauth-clients": () => {
        configured = true;
        return { ...google, configured: true };
      },
    });
    using _fetch = control.stub;
    await using screen = await render(<PluginPage id="gmail" />);

    const card = screen.getByRole("form", { name: "Set up sign-in to Google" });
    const callback = card.getByRole("status", { name: "Callback URL" });
    await expect.element(callback).toHaveTextContent(CALLBACK);
    const clientId = card.getByLabelText("Client ID");
    expect(
      (callback.element().compareDocumentPosition(clientId.element()) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
    ).toBe(true);
    await expect
      .element(card.getByRole("link", { name: "Enable gmailmcp.googleapis.com" }))
      .toHaveAttribute(
        "href",
        "https://console.cloud.google.com/apis/library/gmailmcp.googleapis.com",
      );
    await expect
      .element(card.getByLabelText("Authorization parameters (optional)"))
      .toHaveValue("access_type=offline&prompt=consent");

    await userEvent.fill(clientId, " id-1.apps.googleusercontent.com ");
    await userEvent.fill(card.getByLabelText("Client secret"), "secret-1");
    await press(card.getByRole("button", { name: "Save OAuth client" }));

    await expect
      .element(screen.getByText(/People sign in through your Google OAuth client/))
      .toBeVisible();
    expect(bodyOf(control.calls, "PUT /api/baskule/admin/oauth-clients")).toEqual({
      issuer: GOOGLE,
      clientId: "id-1.apps.googleusercontent.com",
      clientSecret: "secret-1",
      authorizationParams: "access_type=offline&prompt=consent",
    });
  });
});

describe("a member's plugins", () => {
  const member = (overrides: Partial<MemberPlugin>): MemberPlugin => ({
    id: "plugin",
    displayName: "Plugin",
    description: "",
    logo: null,
    category: null,
    on: true,
    enabled: true,
    servers: [],
    skillCount: 0,
    ...overrides,
  });

  it("switches a plugin off, signs in through the connect link and disconnects", async () => {
    let linearOn = true;
    let intercom: MemberPlugin["servers"][number]["connection"] = {
      state: "connected",
      account: "ada@example.test",
      connectedAt: "2026-11-10T08:00:00Z",
    };
    const control = fakeControl({
      "GET /api/baskule/plugins": () => ({
        plugins: [
          member({
            id: "gmail",
            displayName: "Gmail",
            servers: [{ id: "gmail", name: "gmail", connection: { state: "unavailable" } }],
          }),
          member({
            id: "intercom",
            displayName: "Intercom",
            servers: [{ id: "intercom", name: "intercom", connection: intercom }],
          }),
          member({
            id: "linear",
            displayName: "Linear",
            on: linearOn,
            servers: [{ id: "mcp", name: "linear", connection: { state: "not_connected" } }],
          }),
          member({ id: "wiki", displayName: "Wiki", enabled: false }),
        ],
      }),
      "PUT /api/baskule/plugins/linear": (body) => {
        linearOn = (body as { on: boolean }).on;
        return { ok: true };
      },
      "DELETE /api/baskule/plugins/intercom/servers/intercom/connection": () => {
        intercom = { state: "not_connected" };
        return { ok: true };
      },
    });
    using _fetch = control.stub;
    using _confirm = stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    await using screen = await render(<MemberPluginsView />);

    await expect.element(screen.getByText("Not ready yet, ask an administrator")).toBeVisible();
    expect(screen.getByRole("link", { name: "Sign in to Gmail" }).query()).toBeNull();
    await expect
      .element(screen.getByRole("link", { name: "Sign in to Linear" }))
      .toHaveAttribute(
        "href",
        "/api/baskule/plugins/linear/servers/mcp/connect?returnTo=%2Fsettings%2Fplugins",
      );
    await expect.element(screen.getByText("Paused by an administrator")).toBeVisible();
    await expect.element(screen.getByRole("switch", { name: "Use Wiki" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^(Add|Install)/ }).query()).toBeNull();

    await press(screen.getByRole("switch", { name: "Use Linear" }));
    await expect.element(screen.getByRole("switch", { name: "Use Linear" })).not.toBeChecked();
    expect(bodyOf(control.calls, "PUT /api/baskule/plugins/linear")).toEqual({ on: false });

    await expect.element(screen.getByText("Connected as ada@example.test")).toBeVisible();
    await press(screen.getByRole("button", { name: "Disconnect Intercom" }));
    await expect.element(screen.getByRole("link", { name: "Sign in to Intercom" })).toBeVisible();
  });

  it("reports how a sign-in ended and clears it from the address", async () => {
    const previous = window.location.href;
    window.history.replaceState(
      null,
      "",
      "/settings/plugins?plugin=gmail&connection=error&code=oauth_client_required",
    );
    try {
      using _fetch = fakeControl({ "GET /api/baskule/plugins": () => ({ plugins: [] }) }).stub;
      using toast = vi.spyOn(toastManager, "add");
      await using _screen = await render(<MemberPluginsView />);
      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith({
          type: "error",
          title: "Could not connect your account",
          description: "An administrator needs to set up sign-in to this service first.",
        }),
      );
      expect(window.location.search).toBe("");
    } finally {
      window.history.replaceState(null, "", previous);
    }
  });
});

it("keeps the plugin admin pages from members", async () => {
  const previous = readBaskuleMe();
  __setBaskuleMeForTests({
    authentication: { mode: "authenticated", password: true, providers: [] },
    user: { id: "u1", name: "Ada", email: "ada@example.test", role: "member" },
    organizationName: null,
    spaces: [],
    canCreateSpaces: false,
    voiceInput: false,
  } satisfies BaskuleMe);
  try {
    await using screen = await render(<AdminLayout />, { router: "/admin/plugins/browse" });
    await expect
      .element(page.getByText("Only administrators can open the admin panel."))
      .toBeVisible();
    expect(page.getByRole("link", { name: "Browse" }).query()).toBeNull();
    expect(screen.container).toBeTruthy();
  } finally {
    __setBaskuleMeForTests(previous);
  }
});
