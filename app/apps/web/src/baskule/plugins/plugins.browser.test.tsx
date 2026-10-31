// baskule: the plugin screens against a fake ControlCell (fetch): what the admin adds, for whom,
// pauses and sets up, and what a person is told about each plugin and can connect.
import type {
  Account,
  AdminPlugin,
  Group,
  MemberPlugin,
  PluginDraft,
  PluginInput,
} from "@t3tools/contracts/baskule-plugins";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../../test/render";
import { toastManager } from "../../components/ui/toast";
import { BaskuleApiError } from "../api";
import { AddOwnPage } from "../admin/plugins/AddOwnPage";
import { CatalogPage } from "../admin/plugins/CatalogPage";
import { PluginEditor } from "../admin/plugins/PluginEditor";
import { PluginDetailPage } from "../admin/plugins/PluginDetailPage";
import { pluginErrorText } from "./api";
import { UserPluginsView } from "./UserPluginsView";

type Route = (body: unknown, query: URLSearchParams) => unknown;

// Browser tests run without the app's CSS: dialog layers and switches are not hit-testable, so
// clicks go through the DOM, like the other browser tests of this app.
const press = (target: Locator) => act(() => (target.element() as HTMLElement).click());

/** A fetch answering `METHOD /path` from `routes`, recording each call. A route may answer with
 * its own `Response`, such as a refusal, or later, with a promise. */
function fakeControl(routes: Record<string, Route>) {
  const calls: Array<{ readonly route: string; readonly body: unknown; readonly query: string }> =
    [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://test");
    const route = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ route, body, query: url.search });
    const handler = routes[route];
    if (!handler) return Response.json({ error: "not_found" }, { status: 404 });
    const answer = await handler(body, url.searchParams);
    return answer instanceof Response ? answer : Response.json(answer);
  });
  return { calls, stub: stubGlobal("fetch", fetch) };
}

const groups: Group[] = [
  {
    id: "everyone",
    name: "Everyone",
    builtin: "everyone",
    members: [],
    permissions: { canCreateSpaces: false },
    plugins: [],
  },
  {
    id: "sales",
    name: "Sales",
    members: ["u1", "u2"],
    permissions: { canCreateSpaces: false },
    plugins: [],
  },
];

function plugin(overrides: Partial<AdminPlugin>): AdminPlugin {
  return {
    id: "p1",
    vendor: "p1",
    name: "Plugin",
    description: "",
    source: { type: "custom" },
    skills: [],
    servers: [],
    omitted: [],
    enabled: true,
    createdAt: "2026-10-25T10:00:00Z",
    setup: [],
    vendorConfigured: false,
    ...overrides,
  };
}

const postBody = (calls: ReadonlyArray<{ readonly route: string; readonly body: unknown }>) =>
  calls.find((call) => call.route === "POST /api/baskule/admin/plugins")?.body;

describe("admin catalog", () => {
  const linear = plugin({
    id: "linear",
    vendor: "linear",
    name: "Linear",
    source: { type: "catalog" },
    servers: [
      {
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        credential: "user-oauth",
        disabledTools: [],
      },
    ],
    setup: [{ server: "linear", done: true }],
  });

  it("lists services by area and adds one for the chosen groups", async () => {
    let installed: AdminPlugin[] = [];
    const control = fakeControl({
      "GET /api/baskule/admin/plugins": () => ({ plugins: installed }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins": () => {
        installed = [linear];
        return linear;
      },
    });
    using _fetch = control.stub;
    await using screen = await render(<CatalogPage />);

    await expect
      .element(screen.getByRole("heading", { name: "Work management", exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Add Linear" })).toBeVisible();
    await expect
      .element(
        screen.getByText("Not available yet: Figma must admit Baskule to its MCP client catalog."),
      )
      .toBeVisible();
    for (const held of ["Figma", "Shopify", "Docusign", "Microsoft Teams"]) {
      expect(screen.getByRole("button", { name: `Add ${held}` }).query()).toBeNull();
    }
    await expect
      .element(screen.getByRole("link", { name: "Linear documentation" }))
      .toHaveAttribute("target", "_blank");

    await press(screen.getByRole("button", { name: "Add Linear" }));
    const choose = page.getByRole("dialog", { name: "Add Linear" });
    await expect.element(choose.getByRole("checkbox", { name: "Everyone" })).toBeChecked();
    await expect.element(choose.getByRole("checkbox", { name: "Sales" })).not.toBeChecked();
    expect(postBody(control.calls)).toBeUndefined();
    await press(choose.getByRole("checkbox", { name: "Sales" }));
    await press(choose.getByRole("button", { name: "Add plugin" }));

    await expect
      .element(screen.getByRole("link", { name: "Linear is added: open it" }))
      .toHaveAttribute("href", "/admin/plugins/installed/linear");
    expect(postBody(control.calls)).toEqual({ catalog: "linear", groups: ["everyone", "sales"] });
    expect(control.calls.some((call) => call.route.includes("/search"))).toBe(false);
  });

  it("sends an added service that needs its vendor's app to that vendor's setup", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/plugins": () => ({
        plugins: [
          linear,
          plugin({
            id: "gmail",
            vendor: "google",
            name: "Gmail",
            source: { type: "catalog" },
            servers: [
              {
                name: "gmail",
                url: "https://gmailmcp.googleapis.com/mcp/v1",
                credential: "user-oauth",
                oauth: { staticClient: true },
                disabledTools: [],
              },
            ],
            setup: [{ server: "gmail", done: false }],
          }),
        ],
      }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
    });
    using _fetch = control.stub;
    await using screen = await render(<CatalogPage />);

    await expect
      .element(screen.getByRole("link", { name: "Set up Google for Gmail" }))
      .toHaveAttribute("href", "/admin/plugins/installed/gmail");
    await expect.element(screen.getByText("Set up Google", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Linear is added: open it" }))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "Add Gmail" }).query()).toBeNull();
    await expect.element(screen.getByRole("button", { name: "Add Google Calendar" })).toBeVisible();
  });
});

describe("adding your own plugin", () => {
  /** A package with a server to finish (its tenant and its key) and parts Baskule leaves out. */
  const draft: PluginDraft = {
    plugin: {
      name: "Acme CRM",
      description: "Accounts and deals.",
      source: { type: "upload", sha256: "a".repeat(64) },
      servers: [
        {
          name: "crm",
          url: "https://{tenant}.crm.example.test/mcp",
          credential: "organization",
          keyHeaders: ["X-Api-Key"],
          transport: "streamable-http",
        },
      ],
      skills: [
        { name: "call-prep", description: "Prepare a sales call.", instructions: "", files: [] },
      ],
      omitted: [
        { code: "claude_commands", subject: "commands/forecast.md" },
        { code: "local_program", subject: "local-notes" },
      ],
    },
    fixes: [
      { server: "crm", need: "address", placeholders: ["{tenant}"] },
      { server: "crm", need: "key", headers: ["X-Api-Key"] },
    ],
    omitted: [
      { code: "claude_commands", subject: "commands/forecast.md" },
      { code: "local_program", subject: "local-notes" },
    ],
  };
  const saved = (calls: ReadonlyArray<{ readonly route: string }>) =>
    calls.filter((call) => !call.route.startsWith("GET ") && !call.route.endsWith("/inspect"));

  async function reviewUpload() {
    await userEvent.upload(
      page.getByLabelText("Plugin file"),
      new File(["hello"], "crm.zip", { type: "application/zip" }),
    );
    await press(page.getByRole("button", { name: "Review plugin" }));
  }

  it("reviews an uploaded package, fixes it in place and saves it once", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins/inspect": () => draft,
      "POST /api/baskule/admin/plugins": () => plugin({ id: "crm-plugin", name: "Acme CRM" }),
      "PUT /api/baskule/admin/plugins/crm-plugin/secret": () => ({ ok: true }),
    });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await reviewUpload();

    await expect.element(screen.getByText("Tools from 1 server and 1 skill")).toBeVisible();
    await expect
      .element(screen.getByText("Commands for Claude Code. Baskule doesn't use these."))
      .toBeVisible();
    await expect.element(screen.getByText("commands/forecast.md")).toBeVisible();
    await expect.element(screen.getByLabelText("Header for the key")).not.toBeVisible();
    await expect.element(screen.getByRole("checkbox", { name: "Everyone" })).toBeChecked();
    expect(control.calls.find((call) => call.route.endsWith("/inspect"))?.body).toEqual({
      archive: "aGVsbG8=",
    });
    expect(saved(control.calls)).toEqual([]);

    await press(screen.getByRole("button", { name: "Save plugin" }));
    await expect.element(screen.getByText("Fill this in to complete the address.")).toBeVisible();
    expect(saved(control.calls)).toEqual([]);

    await userEvent.type(screen.getByLabelText("tenant", { exact: true }), "acme");
    await userEvent.type(screen.getByLabelText("Key", { exact: true }), "k-1");
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() => expect(saved(control.calls)).toHaveLength(2));
    expect(saved(control.calls)).toEqual([
      {
        route: "POST /api/baskule/admin/plugins",
        body: {
          plugin: {
            ...draft.plugin,
            servers: [{ ...draft.plugin.servers[0], url: "https://acme.crm.example.test/mcp" }],
          },
          groups: ["everyone"],
        },
        query: "",
      },
      {
        route: "PUT /api/baskule/admin/plugins/crm-plugin/secret",
        body: { server: "crm", headers: { "X-Api-Key": "k-1" } },
        query: "",
      },
    ]);
  });

  it("keeps the plugin it created when its key isn't saved, so a retry doesn't add it twice", async () => {
    let refuseKey = true;
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins/inspect": () => draft,
      "POST /api/baskule/admin/plugins": () => plugin({ id: "crm-plugin", name: "Acme CRM" }),
      "PATCH /api/baskule/admin/plugins/crm-plugin": () => plugin({ id: "crm-plugin" }),
      "PUT /api/baskule/admin/plugins/crm-plugin/secret": () => {
        if (!refuseKey) return { ok: true };
        refuseKey = false;
        return Response.json({ error: "invalid_secret_headers" }, { status: 400 });
      },
    });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await reviewUpload();
    await expect.element(screen.getByRole("checkbox", { name: "Everyone" })).toBeChecked();
    await userEvent.type(screen.getByLabelText("tenant", { exact: true }), "acme");
    await userEvent.type(screen.getByLabelText("Key", { exact: true }), "k-1");
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await expect
      .element(
        screen.getByText(
          "Acme CRM was saved, but its key was not: This key can't be sent with that header name.",
        ),
      )
      .toBeVisible();
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() => expect(saved(control.calls)).toHaveLength(4));
    expect(saved(control.calls).map((call) => call.route)).toEqual([
      "POST /api/baskule/admin/plugins",
      "PUT /api/baskule/admin/plugins/crm-plugin/secret",
      "PATCH /api/baskule/admin/plugins/crm-plugin",
      "PUT /api/baskule/admin/plugins/crm-plugin/secret",
    ]);
  });

  it("reads any GitHub link and changes nothing when the review is cancelled", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins/inspect": () => ({
        ...draft,
        plugin: {
          ...draft.plugin,
          source: {
            type: "github",
            repo: "https://github.com/acme/plugins",
            sha: "0123456789abcdef0123456789abcdef01234567",
            path: "crm",
          },
        },
      }),
    });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await press(screen.getByRole("button", { name: "GitHub link" }));
    await userEvent.type(
      screen.getByLabelText("GitHub link", { exact: true }),
      "https://github.com/acme/plugins/tree/main/crm",
    );
    await press(screen.getByRole("button", { name: "Review plugin" }));

    await expect.element(screen.getByText(/^From acme\/plugins\/crm on GitHub/)).toBeVisible();
    expect(screen.getByText(/0123456/).query()).toBeNull();
    await press(screen.getByRole("button", { name: "Cancel" }));

    await expect.element(screen.getByRole("button", { name: "Review plugin" })).toBeVisible();
    expect(control.calls.map((call) => call.route)).not.toContain(
      "POST /api/baskule/admin/plugins",
    );
    expect(control.calls.find((call) => call.route.endsWith("/inspect"))?.body).toEqual({
      github: "https://github.com/acme/plugins/tree/main/crm",
    });
  });

  it("adds an MCP server by its address, named by the admin", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins": () => plugin({ id: "notes" }),
    });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await userEvent.type(
      screen.getByLabelText("Server address", { exact: true }),
      "https://mcp.notes.example.test/mcp",
    );
    await press(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(screen.getByLabelText("Name", { exact: true }), "Notes");
    await press(screen.getByRole("radio", { name: /^Each person connects/ }));
    await expect.element(screen.getByRole("checkbox", { name: "Everyone" })).toBeChecked();
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() =>
      expect(postBody(control.calls)).toEqual({
        plugin: {
          name: "Notes",
          description: "",
          source: { type: "custom" },
          servers: [
            {
              name: "mcp.notes.example.test",
              url: "https://mcp.notes.example.test/mcp",
              credential: "user-oauth",
              transport: "streamable-http",
            },
          ],
          skills: [],
          omitted: [],
        },
        groups: ["everyone"],
      }),
    );
  });
});

describe("adding MCP servers by form or JSON", () => {
  const notesTools = [
    { name: "search_notes", description: "Search notes." },
    { name: "delete_note", description: "Delete a note." },
  ];
  const changes = <T extends { readonly route: string }>(calls: ReadonlyArray<T>) =>
    calls.filter((call) => !call.route.startsWith("GET ") && !call.route.endsWith("/test"));
  const jsonBox = () => page.getByRole("textbox", { name: "Server settings as JSON" });

  it("moves pasted keys out of the JSON into key fields, and keeps them through later edits", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins": () => plugin({ id: "notes-plugin", name: "Notes" }),
      "PUT /api/baskule/admin/plugins/notes-plugin/secret": () => ({ ok: true }),
    });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await press(screen.getByRole("button", { name: "Paste JSON" }));
    await userEvent.fill(
      jsonBox(),
      JSON.stringify({
        servers: {
          notes: {
            type: "http",
            url: "https://mcp.notes.example.test/mcp",
            headers: { Authorization: "Bearer secret-1" },
          },
        },
      }),
    );

    const text = () => (jsonBox().element() as HTMLTextAreaElement).value;
    await vi.waitFor(() => expect(text()).toContain('"Authorization": "${AUTHORIZATION}"'));
    expect(text()).not.toContain("secret-1");
    await press(screen.getByRole("button", { name: "Form", exact: true }));
    const notes = screen.getByRole("group", { name: "notes" });
    await expect
      .element(notes.getByLabelText("Key", { exact: true }))
      .toHaveValue("Bearer secret-1");
    await expect.element(notes.getByRole("radio", { name: /^Organization key/ })).toBeChecked();

    await press(screen.getByRole("button", { name: "JSON", exact: true }));
    await userEvent.fill(
      jsonBox(),
      JSON.stringify({
        mcpServers: {
          notes: {
            url: "https://mcp2.notes.example.test/mcp",
            headers: { Authorization: "${AUTHORIZATION}" },
          },
        },
      }),
    );
    await press(screen.getByRole("button", { name: "Form", exact: true }));
    await expect
      .element(screen.getByLabelText("Address", { exact: true }))
      .toHaveValue("https://mcp2.notes.example.test/mcp");
    await expect
      .element(screen.getByLabelText("Key", { exact: true }))
      .toHaveValue("Bearer secret-1");
    await press(screen.getByRole("button", { name: "JSON", exact: true }));
    await userEvent.fill(jsonBox(), text().replace('"notes"', '"team-notes"'));
    await press(screen.getByRole("button", { name: "Form", exact: true }));
    await expect
      .element(
        screen.getByRole("group", { name: "team-notes" }).getByLabelText("Key", { exact: true }),
      )
      .toHaveValue("Bearer secret-1");
    await userEvent.type(screen.getByLabelText("Name", { exact: true }), "Notes");
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() => expect(changes(control.calls)).toHaveLength(2));
    expect(changes(control.calls)).toEqual([
      {
        route: "POST /api/baskule/admin/plugins",
        body: {
          plugin: {
            name: "Notes",
            description: "",
            source: { type: "custom" },
            servers: [
              {
                name: "team-notes",
                url: "https://mcp2.notes.example.test/mcp",
                transport: "streamable-http",
                credential: "organization",
                keyHeaders: ["Authorization"],
              },
            ],
            skills: [],
            omitted: [],
          },
          groups: ["everyone"],
        },
        query: "",
      },
      {
        route: "PUT /api/baskule/admin/plugins/notes-plugin/secret",
        body: { server: "team-notes", headers: { Authorization: "Bearer secret-1" } },
        query: "",
      },
    ]);
  });

  it("does not carry a typed key to a replacement server with another name and address", async () => {
    const control = fakeControl({ "GET /api/baskule/admin/groups": () => ({ groups }) });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await press(screen.getByRole("button", { name: "Paste JSON" }));
    await userEvent.fill(
      jsonBox(),
      JSON.stringify({
        mcpServers: {
          notes: {
            url: "https://notes.example.test/mcp",
            headers: { Authorization: "Bearer notes-key" },
          },
        },
      }),
    );
    await vi.waitFor(() =>
      expect((jsonBox().element() as HTMLTextAreaElement).value).not.toContain("notes-key"),
    );
    await userEvent.fill(
      jsonBox(),
      JSON.stringify({
        mcpServers: {
          calendar: {
            url: "https://calendar.example.test/mcp",
            headers: { Authorization: "${AUTHORIZATION}" },
          },
        },
      }),
    );
    await press(screen.getByRole("button", { name: "Form", exact: true }));
    await expect
      .element(
        screen.getByRole("group", { name: "calendar" }).getByLabelText("Key", { exact: true }),
      )
      .toHaveValue("");
    expect(changes(control.calls)).toEqual([]);
  });

  const fixtureTools = [
    { name: "fixture_read", description: "Read fixtures." },
    { name: "fixture_write", description: "Write fixtures." },
  ];
  const fixtures = {
    name: "Fixtures",
    description: "",
    source: { type: "custom" as const },
    skills: [],
    omitted: [],
    servers: ["fixture", "archive"].map((name) => ({
      name,
      url: `https://${name}.example.test/mcp`,
      transport: "streamable-http" as const,
      credential: "organization" as const,
      keyHeaders: ["X-Api-Key"],
    })),
  };
  /** The fixture server keyed, tested and with fixture_write switched off, then shown as JSON. */
  async function fixturesAsJson(servers: number) {
    const onSaved = vi.fn();
    const control = fakeControl({
      "POST /api/baskule/admin/plugins/test": () => ({ tools: fixtureTools }),
      "POST /api/baskule/admin/plugins": () => plugin({ id: "p1" }),
      "PUT /api/baskule/admin/plugins/p1/secret": () => ({ ok: true }),
    });
    const initial = { ...fixtures, servers: fixtures.servers.slice(0, servers) };
    await using stack = new AsyncDisposableStack();
    stack.use(control.stub);
    const screen = stack.use(
      await render(
        <PluginEditor
          initial={initial}
          fixes={[]}
          omitted={[]}
          target={{ type: "create", groups, groupsError: null }}
          onCancel={vi.fn()}
          onSaved={onSaved}
        />,
        // This standalone form has no routing or navigation.
        { router: false },
      ),
    );
    for (const server of initial.servers) {
      await userEvent.type(
        screen.getByRole("group", { name: server.name }).getByLabelText("Key", { exact: true }),
        `${server.name}-key`,
      );
    }
    const fixture = screen.getByRole("group", { name: "fixture" });
    await press(fixture.getByRole("button", { name: "Test connection" }));
    await press(fixture.getByRole("switch", { name: "Allow fixture_write" }));
    await expect
      .element(fixture.getByRole("switch", { name: "Allow fixture_write" }))
      .not.toBeChecked();
    await press(screen.getByRole("button", { name: "JSON", exact: true }));
    return { initial, control, onSaved, screen, resources: stack.move() };
  }
  /** Deletes part of the JSON with the keyboard, leaving the caret there for typing. */
  async function deleteJson(start: number, end: number) {
    const box = jsonBox().element() as HTMLTextAreaElement;
    await act(() => {
      box.focus();
      box.setSelectionRange(start, end);
    });
    await userEvent.keyboard("{Backspace}");
  }

  it("keeps a server's key, test and switched-off tools while its name is retyped in the JSON", async () => {
    const { initial, control, onSaved, screen, resources } = await fixturesAsJson(1);
    await using _resources = resources;
    const text = () => (jsonBox().element() as HTMLTextAreaElement).value;
    const start = text().indexOf('"fixture"') + 1;
    await deleteJson(start, start + "fixture".length);
    // The JSON stays readable while the name is empty, and describes no server.
    await vi.waitFor(() => expect(text()).toContain('"": {'));
    await expect.element(screen.getByRole("button", { name: "Form", exact: true })).toBeEnabled();
    await userEvent.keyboard("renamed");
    await vi.waitFor(() => expect(text()).toContain('"renamed": {'));
    await press(screen.getByRole("button", { name: "Form", exact: true }));

    const renamed = screen.getByRole("group", { name: "renamed" });
    await expect.element(renamed.getByLabelText("Key", { exact: true })).toHaveValue("fixture-key");
    await expect
      .element(renamed.getByRole("switch", { name: "Allow fixture_write" }))
      .not.toBeChecked();
    await expect.element(renamed.getByRole("switch", { name: "Allow fixture_read" })).toBeChecked();
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ id: "p1", name: "Fixtures", count: 1 }),
    );
    expect(changes(control.calls).map((call) => [call.route, call.body])).toEqual([
      [
        "POST /api/baskule/admin/plugins",
        {
          plugin: {
            ...initial,
            servers: [{ ...initial.servers[0], name: "renamed", disabledTools: ["fixture_write"] }],
          },
          groups: ["everyone"],
        },
      ],
      [
        "PUT /api/baskule/admin/plugins/p1/secret",
        { server: "renamed", headers: { "X-Api-Key": "fixture-key" } },
      ],
    ]);
  });

  it("keeps what was entered for servers when the JSON is cleared and pasted again without one", async () => {
    const { initial, control, onSaved, screen, resources } = await fixturesAsJson(2);
    await using _resources = resources;
    const text = () => (jsonBox().element() as HTMLTextAreaElement).value;
    await deleteJson(0, text().length);
    await expect.element(jsonBox()).toHaveValue("");
    await userEvent.fill(jsonBox(), '{ "mcpServers": {} }');
    await userEvent.fill(
      jsonBox(),
      JSON.stringify({
        mcpServers: {
          fixture: {
            url: "https://fixture.example.test/mcp",
            headers: { "X-Api-Key": "${X_API_KEY}" },
          },
        },
      }),
    );
    await press(screen.getByRole("button", { name: "Form", exact: true }));

    expect(screen.getByRole("group", { name: "archive" }).query()).toBeNull();
    const fixture = screen.getByRole("group", { name: "fixture" });
    await expect.element(fixture.getByLabelText("Key", { exact: true })).toHaveValue("fixture-key");
    await expect
      .element(fixture.getByRole("switch", { name: "Allow fixture_write" }))
      .not.toBeChecked();
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ id: "p1", name: "Fixtures", count: 1 }),
    );
    expect(changes(control.calls).map((call) => [call.route, call.body])).toEqual([
      [
        "POST /api/baskule/admin/plugins",
        {
          plugin: {
            ...initial,
            servers: [{ ...initial.servers[0], disabledTools: ["fixture_write"] }],
          },
          groups: ["everyone"],
        },
      ],
      [
        "PUT /api/baskule/admin/plugins/p1/secret",
        { server: "fixture", headers: { "X-Api-Key": "fixture-key" } },
      ],
    ]);
  });

  it("keeps JSON it can't read and saves nothing until it is fixed", async () => {
    const control = fakeControl({ "GET /api/baskule/admin/groups": () => ({ groups }) });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await press(screen.getByRole("button", { name: "Paste JSON" }));
    await userEvent.fill(jsonBox(), '{"mcpServers": {"notes": ');

    await expect
      .element(
        screen.getByText("This JSON could not be read. Use an mcpServers or servers object."),
      )
      .toBeVisible();
    await expect.element(jsonBox()).toHaveValue('{"mcpServers": {"notes": ');
    await expect.element(screen.getByRole("button", { name: "Form", exact: true })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Name", { exact: true }), "Notes");
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await expect.element(screen.getByText("Fix the JSON before saving.")).toBeVisible();
    expect(changes(control.calls)).toEqual([]);
  });

  it("tests a server before saving and saves the tools switched off", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins/test": () => ({ tools: notesTools }),
      "POST /api/baskule/admin/plugins": () => plugin({ id: "notes" }),
    });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await userEvent.type(
      screen.getByLabelText("Server address", { exact: true }),
      "https://mcp.notes.example.test/mcp",
    );
    await press(screen.getByRole("button", { name: "Continue" }));
    await press(screen.getByRole("button", { name: "Test connection" }));

    await expect.element(screen.getByText("Delete a note.")).toBeVisible();
    expect(control.calls.find((call) => call.route.endsWith("/test"))?.body).toEqual({
      server: {
        name: "mcp.notes.example.test",
        url: "https://mcp.notes.example.test/mcp",
        credential: "none",
        transport: "streamable-http",
      },
    });
    await press(screen.getByRole("switch", { name: "Allow delete_note" }));
    await expect
      .element(screen.getByRole("switch", { name: "Allow delete_note" }))
      .not.toBeChecked();
    await expect.element(screen.getByRole("switch", { name: "Allow search_notes" })).toBeChecked();
    await userEvent.type(screen.getByLabelText("Name", { exact: true }), "Notes");
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() =>
      expect(postBody(control.calls)).toMatchObject({
        plugin: { servers: [{ name: "mcp.notes.example.test", disabledTools: ["delete_note"] }] },
      }),
    );
  });

  it("waits for a pending sign-in test before saving its result", async () => {
    let answer: (result: unknown) => void = () => {};
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins/test": () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      "POST /api/baskule/admin/plugins": () => plugin({ id: "notes" }),
    });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await userEvent.fill(
      screen.getByLabelText("Server address", { exact: true }),
      "https://mcp.notes.example.test/mcp",
    );
    await press(screen.getByRole("button", { name: "Continue" }));
    await userEvent.fill(screen.getByLabelText("Name", { exact: true }), "Notes");
    await press(screen.getByRole("button", { name: "Test connection" }));
    try {
      await expect.element(screen.getByRole("button", { name: "Save plugin" })).toBeDisabled();
      screen.getByLabelText("Name", { exact: true }).element().closest("form")!.requestSubmit();
      expect(
        control.calls.filter((call) => call.route === "POST /api/baskule/admin/plugins"),
      ).toEqual([]);
    } finally {
      answer({ signIn: "account", staticClient: true });
    }
    await expect.element(screen.getByRole("button", { name: "Save plugin" })).toBeEnabled();
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await vi.waitFor(() =>
      expect(postBody(control.calls)).toMatchObject({
        plugin: {
          servers: [{ credential: "user-oauth", oauth: { staticClient: true } }],
        },
      }),
    );
  });

  it("shows a test's tools only while the server has the settings it was tested with", async () => {
    let answer: (tools: unknown) => void = () => {};
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins/test": () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await userEvent.type(
      screen.getByLabelText("Server address", { exact: true }),
      "https://mcp.notes.example.test/mcp",
    );
    await press(screen.getByRole("button", { name: "Continue" }));
    await press(screen.getByRole("button", { name: "Test connection" }));
    await expect.element(screen.getByRole("button", { name: /Testing…/ })).toBeDisabled();
    await vi.waitFor(() =>
      expect(control.calls.some((call) => call.route.endsWith("/test"))).toBe(true),
    );

    const address = screen.getByLabelText("Address", { exact: true });
    await userEvent.fill(address, "https://other.notes.example.test/mcp");
    await expect.element(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
    await act(() => answer({ tools: notesTools }));

    await userEvent.fill(address, "https://mcp.notes.example.test/mcp");
    await expect
      .element(screen.getByRole("switch", { name: "Allow delete_note" }))
      .toBeInTheDocument();
    await userEvent.fill(address, "https://other.notes.example.test/mcp");
    await expect.element(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
    expect(screen.getByRole("switch").query()).toBeNull();
  });

  it("switches a server that asks people to sign in to their own accounts", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins/test": () => ({ signIn: "account", staticClient: true }),
      "POST /api/baskule/admin/plugins": () => plugin({ id: "notes" }),
    });
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await userEvent.type(
      screen.getByLabelText("Server address", { exact: true }),
      "https://mcp.notes.example.test/mcp",
    );
    await press(screen.getByRole("button", { name: "Continue" }));
    await press(screen.getByRole("button", { name: "Test connection" }));

    await expect
      .element(screen.getByText("People connect their own account after this plugin is saved."))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Your administrator needs to register this service before people can connect.",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("radio", { name: /^Each person connects/ }))
      .toBeChecked();
    await userEvent.type(screen.getByLabelText("Name", { exact: true }), "Notes");
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await vi.waitFor(() =>
      expect(postBody(control.calls)).toMatchObject({
        plugin: { servers: [{ credential: "user-oauth", oauth: { staticClient: true } }] },
      }),
    );
  });

  it("adds pasted servers as separate plugins and retries only the one that failed", async () => {
    let refuse = true;
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins": (body) => {
        const name = (body as { plugin: { name: string } }).plugin.name;
        if (name === "beta" && refuse) {
          refuse = false;
          return Response.json({ error: "plugin_storage_limit" }, { status: 413 });
        }
        return plugin({ id: `${name}-id`, name });
      },
    });
    using _fetch = control.stub;
    using add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await using screen = await render(<AddOwnPage />);
    await press(screen.getByRole("button", { name: "Paste JSON" }));
    await userEvent.fill(
      jsonBox(),
      JSON.stringify({
        mcpServers: {
          alpha: { url: "https://alpha.example.test/mcp" },
          beta: { url: "https://beta.example.test/mcp" },
        },
      }),
    );
    await press(screen.getByRole("radio", { name: /^Separate plugins/ }));
    expect(screen.getByLabelText("Name", { exact: true }).query()).toBeNull();
    await press(screen.getByRole("button", { name: "Save plugins" }));

    await expect
      .element(
        screen.getByText("There is no room for more plugins. Remove one you don't use first."),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText("1 of 2 plugins are ready. Save again to finish the rest."))
      .toBeVisible();
    await expect.element(screen.getByRole("radio", { name: /^One plugin/ })).toBeDisabled();
    await press(screen.getByRole("button", { name: "Save plugins" }));

    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith({ type: "success", title: "2 plugins were added" }),
    );
    expect(
      changes(control.calls).map((call) => (call.body as { plugin: PluginInput }).plugin),
    ).toEqual(
      ["alpha", "beta", "beta"].map((name) => ({
        name,
        description: "",
        source: { type: "custom" },
        servers: [
          {
            name,
            url: `https://${name}.example.test/mcp`,
            transport: "streamable-http",
            credential: "none",
          },
        ],
        skills: [],
        omitted: [],
      })),
    );
  });

  it("clears a separate plugin's key once it is saved, even when a later plugin fails", async () => {
    let refuse = true;
    const control = fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins": (body) => {
        const name = (body as { plugin: { name: string } }).plugin.name;
        if (name === "beta" && refuse) {
          refuse = false;
          return Response.json({ error: "plugin_storage_limit" }, { status: 413 });
        }
        return plugin({ id: `${name}-id`, name });
      },
      "PUT /api/baskule/admin/plugins/alpha-id/secret": () => ({ ok: true }),
      "PUT /api/baskule/admin/plugins/beta-id/secret": () => ({ ok: true }),
    });
    using _fetch = control.stub;
    using add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await using screen = await render(<AddOwnPage />);
    await press(screen.getByRole("button", { name: "Paste JSON" }));
    await userEvent.fill(
      jsonBox(),
      JSON.stringify({
        mcpServers: Object.fromEntries(
          ["alpha", "beta"].map((name) => [
            name,
            { url: `https://${name}.example.test/mcp`, headers: { "X-Api-Key": `${name}-key` } },
          ]),
        ),
      }),
    );
    await press(screen.getByRole("radio", { name: /^Separate plugins/ }));
    await press(screen.getByRole("button", { name: "Form", exact: true }));
    await press(screen.getByRole("button", { name: "Save plugins" }));

    await expect
      .element(screen.getByText("1 of 2 plugins are ready. Save again to finish the rest."))
      .toBeVisible();
    const alpha = screen.getByRole("group", { name: "alpha" });
    await expect.element(alpha.getByLabelText("Key", { exact: true })).toHaveValue("");
    await expect
      .element(alpha.getByText("A key is saved. Leave this empty to keep it."))
      .toBeVisible();
    await expect
      .element(screen.getByRole("group", { name: "beta" }).getByLabelText("Key", { exact: true }))
      .toHaveValue("beta-key");
    await press(screen.getByRole("button", { name: "Save plugins" }));

    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith({ type: "success", title: "2 plugins were added" }),
    );
    expect(
      changes(control.calls).map((call) =>
        call.route.endsWith("/secret")
          ? [call.route, call.body]
          : [call.route, (call.body as { plugin: PluginInput }).plugin.name],
      ),
    ).toEqual([
      ["POST /api/baskule/admin/plugins", "alpha"],
      [
        "PUT /api/baskule/admin/plugins/alpha-id/secret",
        { server: "alpha", headers: { "X-Api-Key": "alpha-key" } },
      ],
      ["POST /api/baskule/admin/plugins", "beta"],
      ["POST /api/baskule/admin/plugins", "beta"],
      [
        "PUT /api/baskule/admin/plugins/beta-id/secret",
        { server: "beta", headers: { "X-Api-Key": "beta-key" } },
      ],
    ]);
  });

  it("lists a saved server's tools with its saved key, but never sends it to a new address", async () => {
    const initial = {
      name: "CRM",
      description: "",
      source: { type: "custom" as const },
      skills: [],
      omitted: [],
      servers: [
        {
          name: "crm",
          url: "https://mcp.crm.example.test/mcp",
          credential: "organization" as const,
          keyHeaders: ["X-Api-Key"],
          disabledTools: ["delete_note"],
        },
      ],
    };
    const control = fakeControl({
      "GET /api/baskule/admin/plugins/p1/tools": () => ({ tools: notesTools }),
      "POST /api/baskule/admin/plugins/test": () => ({ tools: notesTools }),
    });
    using _fetch = control.stub;
    await using screen = await render(
      <PluginEditor
        initial={initial}
        fixes={[]}
        omitted={[]}
        target={{ type: "edit", id: "p1", savedKeys: new Set(["crm"]) }}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
      // This standalone form has no routing or navigation.
      { router: false },
    );
    await press(screen.getByRole("button", { name: "Test connection" }));
    await expect
      .element(screen.getByRole("switch", { name: "Allow delete_note" }))
      .not.toBeChecked();
    expect(control.calls.find((call) => call.route.endsWith("/tools"))?.query).toBe("?server=crm");

    await userEvent.fill(
      screen.getByLabelText("Address", { exact: true }),
      "https://changed.example.test/mcp",
    );
    await press(screen.getByRole("button", { name: "Test connection" }));
    await expect.element(screen.getByText("Enter this key too.", { exact: true })).toBeVisible();
    expect(control.calls.some((call) => call.route.endsWith("/test"))).toBe(false);

    await userEvent.type(screen.getByLabelText("Key", { exact: true }), "new-key");
    await press(screen.getByRole("button", { name: "Test connection" }));
    await vi.waitFor(() =>
      expect(control.calls.find((call) => call.route.endsWith("/test"))?.body).toEqual({
        server: {
          name: "crm",
          url: "https://changed.example.test/mcp",
          credential: "organization",
          keyHeaders: ["X-Api-Key"],
          disabledTools: ["delete_note"],
        },
        headers: { "X-Api-Key": "new-key" },
      }),
    );
  });

  it("sends only the tool switches the admin changed, so switches changed since it opened are kept", async () => {
    const initial = {
      name: "Notes",
      description: "",
      source: { type: "custom" as const },
      skills: [],
      omitted: [],
      servers: ["notes", "files", "drafts"].map((name) => ({
        name,
        url: `https://${name}.example.test/mcp`,
        transport: "streamable-http" as const,
        credential: "none" as const,
        disabledTools: ["delete_note"],
      })),
    };
    const onSaved = vi.fn();
    const control = fakeControl({
      "GET /api/baskule/admin/plugins/p1/tools": () => ({ tools: notesTools }),
      "PATCH /api/baskule/admin/plugins/p1": () => plugin({}),
    });
    using _fetch = control.stub;
    await using screen = await render(
      <PluginEditor
        initial={initial}
        fixes={[]}
        omitted={[]}
        target={{ type: "edit", id: "p1", savedKeys: new Set() }}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
      // This standalone form has no routing or navigation.
      { router: false },
    );
    const files = screen.getByRole("group", { name: "files" });
    await press(files.getByRole("button", { name: "Test connection" }));
    await press(files.getByRole("switch", { name: "Allow delete_note" }));
    await expect.element(files.getByRole("switch", { name: "Allow delete_note" })).toBeChecked();
    const drafts = screen.getByRole("group", { name: "drafts" });
    await userEvent.click(drafts.getByText("Technical details", { exact: true }));
    await userEvent.fill(drafts.getByLabelText("Server name", { exact: true }), "team-drafts");
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [notes, ...changed] = initial.servers;
    const { disabledTools: _loaded, ...untouched } = notes!;
    expect(
      control.calls.find((call) => call.route === "PATCH /api/baskule/admin/plugins/p1")?.body,
    ).toEqual({
      plugin: {
        ...initial,
        servers: [
          untouched,
          { ...changed[0], disabledTools: [] },
          { ...changed[1], name: "team-drafts" },
        ],
      },
    });
  });
});

describe("a saved plugin's tools", () => {
  it("switches a tool off and on again, and says when the admin has no account to list them", async () => {
    let off: string[] = [];
    const control = fakeControl({
      "GET /api/baskule/admin/plugins": () => ({
        plugins: [
          plugin({
            name: "Notes",
            servers: [
              {
                name: "notes",
                url: "https://mcp.notes.example.test/mcp",
                credential: "none",
                disabledTools: off,
              },
              {
                name: "mail",
                url: "https://mcp.mail.example.test/mcp",
                credential: "user-oauth",
                disabledTools: [],
              },
            ],
          }),
        ],
      }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "GET /api/baskule/admin/plugins/p1/tools": (_body, query) =>
        query.get("server") === "notes"
          ? {
              tools: [
                { name: "search_notes", description: "Search notes." },
                { name: "delete_note", description: "Delete a note." },
              ],
            }
          : Response.json({ error: "connection_not_allowed" }, { status: 409 }),
      "PATCH /api/baskule/admin/plugins/p1": (body) => {
        off = (body as { disabledTools: Record<string, string[]> }).disabledTools.notes!;
        return plugin({});
      },
    });
    using _fetch = control.stub;
    await using screen = await render(<PluginDetailPage id="p1" />);

    await press(screen.getByRole("button", { name: "Show tools of notes" }));
    const deleteNote = screen.getByRole("switch", { name: "Allow delete_note" });
    await expect.element(deleteNote).toBeChecked();
    await press(deleteNote);
    await expect.element(screen.getByText("1 tool switched off")).toBeVisible();
    await expect.element(deleteNote).not.toBeChecked();
    await expect.element(deleteNote).toBeEnabled();
    await press(deleteNote);
    await expect.element(deleteNote).toBeChecked();
    expect(
      control.calls.filter((call) => call.route.startsWith("PATCH ")).map((call) => call.body),
    ).toEqual([{ disabledTools: { notes: ["delete_note"] } }, { disabledTools: { notes: [] } }]);

    await press(screen.getByRole("button", { name: "Show tools of mail" }));
    await expect
      .element(screen.getByText("Connect your own account in Settings → Plugins to see its tools."))
      .toBeVisible();
  });
});

describe("pausing a plugin", () => {
  it("pauses it for everyone and offers to resume it", async () => {
    let enabled = true;
    const control = fakeControl({
      "GET /api/baskule/admin/plugins": () => ({ plugins: [plugin({ name: "Wiki", enabled })] }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "PATCH /api/baskule/admin/plugins/p1": (body) => {
        enabled = (body as { enabled: boolean }).enabled;
        return plugin({ name: "Wiki", enabled });
      },
    });
    using _fetch = control.stub;
    await using screen = await render(<PluginDetailPage id="p1" />);

    await press(screen.getByRole("button", { name: "Pause Wiki" }));
    await expect
      .element(screen.getByText("Paused. No one can use it until you resume it."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Resume Wiki" })).toBeVisible();
    expect(
      control.calls.find((call) => call.route === "PATCH /api/baskule/admin/plugins/p1")?.body,
    ).toEqual({ enabled: false });
  });
});

describe("signing in to a plugin's service", () => {
  it("keeps a catalog service's sign-in and links to its vendor setup instructions", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/plugins": () => ({
        plugins: [
          plugin({
            id: "gmail",
            vendor: "google",
            name: "Gmail",
            source: { type: "catalog" },
            servers: [
              {
                name: "gmail",
                url: "https://gmailmcp.googleapis.com/mcp/v1",
                credential: "user-oauth",
                oauth: { staticClient: true },
                disabledTools: [],
              },
            ],
            setup: [{ server: "gmail", done: false }],
          }),
        ],
      }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "PUT /api/baskule/admin/vendors/google": () => ({ ok: true, configured: true }),
    });
    using _fetch = control.stub;
    await using screen = await render(<PluginDetailPage id="gmail" />);

    await expect.element(screen.getByText("Your app at Google", { exact: true })).toBeVisible();
    expect(screen.getByLabelText("How gmail signs in", { exact: true }).query()).toBeNull();
    await expect
      .element(screen.getByText("Each person connects their own account", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText("Tools · Baskule catalog")).toBeVisible();
    const instructions = screen.getByRole("link", { name: "Setup instructions" });
    await expect.element(instructions).toHaveAttribute("target", "_blank");
    await expect.element(instructions).toHaveAttribute("rel", "noreferrer noopener");

    await userEvent.type(screen.getByLabelText("Client ID", { exact: true }), "client-1");
    await userEvent.type(screen.getByLabelText("Client secret", { exact: true }), "s3cret");
    await press(screen.getByRole("button", { name: "Save setup" }));

    expect(
      control.calls.find((call) => call.route === "PUT /api/baskule/admin/vendors/google")?.body,
    ).toEqual({
      clientId: "client-1",
      tokenEndpointAuthMethod: "client_secret_post",
      clientSecret: "s3cret",
    });
  });

  const crm = { name: "crm", url: "https://mcp.crm.example.test/mcp", disabledTools: [] };

  it("edits a plugin an admin brought in the shared editor and saves it whole", async () => {
    const skill = {
      name: "notes",
      description: "Write notes.",
      instructions: "Write them.",
      files: [],
    };
    const control = fakeControl({
      "GET /api/baskule/admin/plugins": () => ({
        plugins: [
          plugin({
            name: "CRM",
            source: { type: "upload", sha256: "b".repeat(64) },
            servers: [{ ...crm, credential: "organization", transport: "streamable-http" }],
            skills: [{ name: skill.name, description: skill.description }],
            setup: [{ server: "crm", done: true }],
          }),
        ],
      }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "GET /api/baskule/admin/plugins/p1/skills": () => ({
        skills: [skill],
        editable: true,
      }),
      "PATCH /api/baskule/admin/plugins/p1": () => plugin({}),
    });
    using _fetch = control.stub;
    await using screen = await render(<PluginDetailPage id="p1" />);

    expect(screen.getByLabelText("How crm signs in", { exact: true }).query()).toBeNull();
    await expect.element(screen.getByRole("button", { name: "Download as zip" })).toBeVisible();
    await press(screen.getByRole("button", { name: "Edit CRM" }));
    await expect
      .element(screen.getByText("A key is saved. Leave this empty to keep it."))
      .toBeVisible();
    await press(screen.getByRole("radio", { name: /^Each person connects/ }));
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() =>
      expect(
        control.calls.find((call) => call.route === "PATCH /api/baskule/admin/plugins/p1")?.body,
      ).toEqual({
        plugin: {
          name: "CRM",
          description: "",
          source: { type: "upload", sha256: "b".repeat(64) },
          servers: [
            {
              name: crm.name,
              url: crm.url,
              credential: "user-oauth",
              transport: "streamable-http",
            },
          ],
          skills: [skill],
          omitted: [],
        },
      }),
    );
    expect(control.calls.some((call) => call.route.endsWith("/secret"))).toBe(false);
  });

  it("keeps every saved key's header name when replacing keys in the editor", async () => {
    const initial = {
      name: "CRM",
      description: "",
      source: { type: "custom" as const },
      skills: [],
      omitted: [],
      servers: [
        { ...crm, credential: "organization" as const, keyHeaders: ["X-Api-Key", "X-Workspace"] },
      ],
    };
    const control = fakeControl({
      "PATCH /api/baskule/admin/plugins/p1": () => plugin({}),
      "PUT /api/baskule/admin/plugins/p1/secret": () => ({ ok: true }),
    });
    using _fetch = control.stub;
    await using screen = await render(
      <PluginEditor
        initial={initial}
        fixes={[]}
        omitted={[]}
        target={{ type: "edit", id: "p1", savedKeys: new Set(["crm"]) }}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText("Key 1", { exact: true }), "new-key");
    await userEvent.type(screen.getByLabelText("Key 2", { exact: true }), "workspace-key");
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await vi.waitFor(() =>
      expect(control.calls.find((call) => call.route.endsWith("/secret"))?.body).toEqual({
        server: "crm",
        headers: { "X-Api-Key": "new-key", "X-Workspace": "workspace-key" },
      }),
    );
  });

  it("requires keys again when a saved key's header name is changed", async () => {
    const initial = {
      name: "CRM",
      description: "",
      source: { type: "custom" as const },
      skills: [],
      omitted: [],
      servers: [{ ...crm, credential: "organization" as const, keyHeaders: ["X-Api-Key"] }],
    };
    const control = fakeControl({});
    using _fetch = control.stub;
    await using screen = await render(
      <PluginEditor
        initial={initial}
        fixes={[]}
        omitted={[]}
        target={{ type: "edit", id: "p1", savedKeys: new Set(["crm"]) }}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
      // This standalone form has no routing or navigation.
      { router: false },
    );
    await userEvent.click(screen.getByText("Technical details", { exact: true }));
    await expect
      .element(screen.getByLabelText("Header for the key", { exact: true }))
      .toBeVisible();
    await userEvent.fill(screen.getByLabelText("Header for the key", { exact: true }), "X-Changed");
    await expect
      .element(screen.getByText("The key fields changed. Enter all keys again before saving."))
      .toBeVisible();
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await expect.element(screen.getByText("Enter this key too.", { exact: true })).toBeVisible();
    expect(
      control.calls.filter(
        (call) => call.route.startsWith("PATCH ") || call.route.startsWith("PUT "),
      ),
    ).toEqual([]);
  });

  it("clears each key once it is saved, so a retry sends only the keys that were not", async () => {
    const mail = {
      name: "mail",
      url: "https://mcp.mail.example.test/mcp",
      credential: "organization" as const,
    };
    const initial = {
      name: "CRM",
      description: "",
      source: { type: "custom" as const },
      skills: [],
      omitted: [],
      servers: [
        { ...crm, credential: "organization" as const, keyHeaders: ["X-Api-Key"] },
        { ...mail, keyHeaders: ["Cookie"] },
      ],
    };
    const onSaved = vi.fn();
    const control = fakeControl({
      "POST /api/baskule/admin/plugins": () => plugin({ id: "p1" }),
      "PATCH /api/baskule/admin/plugins/p1": () => plugin({}),
      "PUT /api/baskule/admin/plugins/p1/secret": (body) =>
        "Cookie" in (body as { readonly headers: object }).headers
          ? Response.json({ error: "invalid_secret_headers" }, { status: 400 })
          : { ok: true },
    });
    using _fetch = control.stub;
    await using screen = await render(
      <PluginEditor
        initial={initial}
        fixes={[]}
        omitted={[]}
        target={{ type: "create", groups, groupsError: null }}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );
    const key = screen.getByLabelText("Key", { exact: true });
    const header = screen.getByLabelText("Header for the key", { exact: true });
    await userEvent.type(key.nth(0), "crm-key");
    await userEvent.type(key.nth(1), "mail-key");
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await expect
      .element(
        screen.getByText(
          "CRM was saved, but its key was not: This key can't be sent with that header name.",
        ),
      )
      .toBeVisible();
    await expect.element(key.nth(0)).toHaveValue("");
    await expect.element(key.nth(1)).toHaveValue("mail-key");
    await expect
      .element(screen.getByText("A key is saved. Leave this empty to keep it."))
      .toBeVisible();

    await userEvent.click(screen.getByText("Technical details", { exact: true }).nth(0));
    await userEvent.click(screen.getByText("Technical details", { exact: true }).nth(1));
    await userEvent.fill(header.nth(0), "X-Changed");
    await expect.element(screen.getByText("Enter this key too.", { exact: true })).toBeVisible();
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await userEvent.fill(header.nth(0), "X-Api-Key");
    await userEvent.fill(header.nth(1), "X-Mail-Key");
    await expect.element(key.nth(1)).toHaveValue("mail-key");
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith({ id: "p1", name: "CRM", count: 1 }),
    );
    expect(
      control.calls
        .filter((call) => !call.route.startsWith("GET "))
        .map((call) => [call.route, call.body]),
    ).toEqual([
      ["POST /api/baskule/admin/plugins", expect.anything()],
      [
        "PUT /api/baskule/admin/plugins/p1/secret",
        { server: "crm", headers: { "X-Api-Key": "crm-key" } },
      ],
      [
        "PUT /api/baskule/admin/plugins/p1/secret",
        { server: "mail", headers: { Cookie: "mail-key" } },
      ],
      [
        "PATCH /api/baskule/admin/plugins/p1",
        {
          plugin: {
            ...initial,
            servers: [
              { ...crm, credential: "organization", keyHeaders: ["X-Api-Key"] },
              { ...mail, keyHeaders: ["X-Mail-Key"] },
            ],
          },
        },
      ],
      [
        "PUT /api/baskule/admin/plugins/p1/secret",
        { server: "mail", headers: { "X-Mail-Key": "mail-key" } },
      ],
    ]);
  });

  it("explains that changing a server needs its key again", async () => {
    const initial = {
      name: "CRM",
      description: "",
      source: { type: "custom" as const },
      skills: [],
      omitted: [],
      servers: [{ ...crm, credential: "organization" as const, keyHeaders: ["X-Api-Key"] }],
    };
    await using screen = await render(
      <PluginEditor
        initial={initial}
        fixes={[]}
        omitted={[]}
        target={{ type: "edit", id: "p1", savedKeys: new Set(["crm"]) }}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await expect
      .element(screen.getByText("A key is saved. Leave this empty to keep it."))
      .toBeVisible();
    await userEvent.fill(
      screen.getByLabelText("Address", { exact: true }),
      "https://changed.example/mcp",
    );
    await expect
      .element(
        screen.getByText("The server changed. Enter its key again, or finish setting it up later."),
      )
      .toBeVisible();
    expect(screen.getByText("A key is saved. Leave this empty to keep it.").query()).toBeNull();
  });

  it("saves the vendor's app once, never shows it back, and removes it", async () => {
    let configured = false;
    const control = fakeControl({
      "GET /api/baskule/admin/plugins": () => ({
        plugins: [
          plugin({
            name: "CRM",
            vendor: "crm-vendor",
            servers: [{ ...crm, credential: "user-oauth", oauth: { staticClient: true } }],
            setup: [{ server: "crm", done: configured }],
            vendorConfigured: configured,
          }),
        ],
      }),
      "GET /api/baskule/admin/groups": () => ({
        groups: groups.map((group) => (group.builtin ? { ...group, plugins: ["p1"] } : group)),
      }),
      "PUT /api/baskule/admin/vendors/crm-vendor": (body) => {
        configured = body !== null;
        return { ok: true, configured };
      },
    });
    using _fetch = control.stub;
    using _confirm = stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    await using screen = await render(<PluginDetailPage id="p1" />);

    await expect.element(screen.getByText("Not saved", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByText("People can't use it until you finish setting it up below."))
      .toBeVisible();
    await expect
      .element(screen.getByLabelText("Callback address", { exact: true }))
      .toHaveValue(`${window.location.origin}/api/baskule/plugins/oauth/callback`);
    expect(screen.getByRole("button", { name: "Remove setup" }).query()).toBeNull();

    await userEvent.type(screen.getByLabelText("Client ID", { exact: true }), "client-1");
    await expect.element(screen.getByRole("button", { name: "Save setup" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Client secret", { exact: true }), "s3cret");
    await press(screen.getByRole("button", { name: "Save setup" }));

    await expect.element(screen.getByText("Saved", { exact: true })).toBeVisible();
    await expect.element(screen.getByLabelText("Client ID", { exact: true })).toHaveValue("");
    await expect.element(screen.getByLabelText("Client secret", { exact: true })).toHaveValue("");
    expect(
      screen.getByText("People can't use it until you finish setting it up below.").query(),
    ).toBeNull();

    await press(screen.getByRole("button", { name: "Remove setup" }));
    await expect.element(screen.getByText("Not saved", { exact: true })).toBeVisible();
    expect(
      control.calls
        .filter((call) => call.route === "PUT /api/baskule/admin/vendors/crm-vendor")
        .map((call) => call.body),
    ).toEqual([
      {
        clientId: "client-1",
        tokenEndpointAuthMethod: "client_secret_post",
        clientSecret: "s3cret",
      },
      null,
    ]);
  });
});

describe("a person's plugins", () => {
  const member = (overrides: Partial<MemberPlugin>): MemberPlugin => ({
    id: "m1",
    name: "Plugin",
    description: "",
    skills: [],
    status: "ready",
    servers: [],
    ...overrides,
  });
  const account = (overrides: Partial<Account> & Pick<Account, "id" | "label">): Account => ({
    default: true,
    status: "ready",
    ...overrides,
  });
  /** An account plugin whose status follows its default account, as the ControlCell derives it. */
  const withAccounts = (id: string, name: string, accounts: Account[]): MemberPlugin => {
    const status = accounts.find((entry) => entry.default)?.status ?? "connect";
    return member({
      id,
      name,
      status,
      servers: [{ name: id, credential: "user-oauth", status, accounts }],
    });
  };
  const changes = (calls: ReadonlyArray<{ readonly route: string }>) =>
    calls.filter((call) => !call.route.startsWith("GET "));

  it("tells the status of each plugin and offers only the action it needs", async () => {
    let notes = [account({ id: "notes-1", label: "Notes" })];
    const control = fakeControl({
      "GET /api/baskule/plugins": () => ({
        plugins: [
          withAccounts("drive", "Google Drive", []),
          withAccounts("mail", "Mail", [
            account({ id: "mail-1", label: "Mail", status: "reconnect" }),
          ]),
          member({
            id: "search",
            name: "Search",
            status: "needs_setup",
            servers: [
              { name: "search", status: "needs_setup", credential: "organization", accounts: [] },
            ],
          }),
          member({
            id: "sales",
            name: "Sales",
            status: "unavailable",
            skills: [{ name: "pipeline", description: "Pipeline reviews." }],
          }),
          withAccounts("notes", "Notes", notes),
          member({
            id: "wiki",
            name: "Wiki",
            servers: [{ name: "wiki", status: "ready", credential: "organization", accounts: [] }],
          }),
        ],
      }),
      "DELETE /api/baskule/plugins/notes/accounts/notes-1": () => {
        notes = [];
        return { ok: true };
      },
    });
    using _fetch = control.stub;
    using _confirm = stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    await using screen = await render(<UserPluginsView />);

    await expect.element(screen.getByText("Connect your Google Drive account")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Connect your Google Drive account" }))
      .toBeEnabled();
    await expect.element(screen.getByText("Reconnect your Mail account")).toBeVisible();
    await expect.element(screen.getByText("Needs reconnecting")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Reconnect Mail" })).toBeEnabled();
    await expect
      .element(screen.getByText("Your administrator needs to finish setting it up"))
      .toBeVisible();
    await expect.element(screen.getByText("Not available to you")).toBeVisible();
    expect(screen.getByText("Ready", { exact: true }).all()).toHaveLength(2);
    expect(screen.getByRole("switch").query()).toBeNull();
    expect(screen.getByRole("button", { name: /^(Connect your|Reconnect) / }).all()).toHaveLength(
      2,
    );
    // An organization's key is not the person's to disconnect.
    expect(screen.getByRole("list", { name: "Your Wiki accounts" }).query()).toBeNull();
    expect(screen.getByRole("button", { name: /^Disconnect / }).all()).toHaveLength(2);

    await press(screen.getByRole("button", { name: "Disconnect Notes" }));
    await expect.element(screen.getByText("Connect your Notes account")).toBeVisible();
    expect(screen.getByText("Ready", { exact: true }).all()).toHaveLength(1);
    expect(changes(control.calls)).toEqual([
      { route: "DELETE /api/baskule/plugins/notes/accounts/notes-1", body: undefined, query: "" },
    ]);
  });

  it("names an account before connecting it, starting from the plugin's name", async () => {
    const control = fakeControl({
      "GET /api/baskule/plugins": () => ({
        plugins: [
          withAccounts("drive", "Google Drive", []),
          withAccounts("notes", "Notes", [account({ id: "notes-1", label: "Work" })]),
        ],
      }),
    });
    using _fetch = control.stub;
    await using screen = await render(<UserPluginsView />);

    await press(screen.getByRole("button", { name: "Connect your Google Drive account" }));
    const first = page.getByRole("dialog", { name: "Connect your Google Drive account" });
    await expect.element(first.getByLabelText("Account name")).toHaveValue("Google Drive");
    await expect
      .element(first.getByText("Choose a name you will recognize, such as Work or Second."))
      .toBeVisible();
    await expect.element(first.getByRole("button", { name: "Connect account" })).toBeEnabled();
    await press(first.getByRole("button", { name: "Cancel" }));
    await expect.element(first).not.toBeInTheDocument();

    await press(screen.getByRole("button", { name: "Add another Notes account" }));
    const another = page.getByRole("dialog", { name: "Add another Notes account" });
    await expect.element(another.getByLabelText("Account name")).toHaveValue("");
    await expect.element(another.getByRole("button", { name: "Connect account" })).toBeDisabled();
    await userEvent.type(another.getByLabelText("Account name"), "Work");
    await expect
      .element(another.getByText("You already have an account with this name."))
      .toBeVisible();
    await expect.element(another.getByRole("button", { name: "Connect account" })).toBeDisabled();
    await userEvent.clear(another.getByLabelText("Account name"));
    await userEvent.type(another.getByLabelText("Account name"), "Second");
    await expect.element(another.getByRole("button", { name: "Connect account" })).toBeEnabled();
    expect(changes(control.calls)).toEqual([]);
  });

  it("renames, changes the default and disconnects the default only for a chosen one", async () => {
    let accounts = [
      account({ id: "a1", label: "Work", status: "reconnect" }),
      account({ id: "a2", label: "Second", default: false }),
    ];
    const control = fakeControl({
      "GET /api/baskule/plugins": () => ({ plugins: [withAccounts("gmail", "Gmail", accounts)] }),
      "PATCH /api/baskule/plugins/gmail/accounts/a2": (body) => {
        const patch = body as { label?: string; default?: true };
        accounts = accounts.map((entry) =>
          entry.id === "a2"
            ? {
                ...entry,
                label: patch.label ?? entry.label,
                default: entry.default || !!patch.default,
              }
            : { ...entry, default: entry.default && !patch.default },
        );
        return { ok: true };
      },
      "DELETE /api/baskule/plugins/gmail/accounts/a2": (_body, query) => {
        if (query.get("default") !== "a1")
          return Response.json({ error: "default_account_required" }, { status: 409 });
        accounts = accounts
          .filter((entry) => entry.id !== "a2")
          .map((entry) => ({ ...entry, default: true }));
        return { ok: true };
      },
    });
    using _fetch = control.stub;
    await using screen = await render(<UserPluginsView />);
    const list = screen.getByRole("list", { name: "Your Gmail accounts" });

    await expect.element(screen.getByText("Reconnect your Gmail account")).toBeVisible();
    await expect.element(list.getByText("Default", { exact: true })).toBeVisible();
    expect(list.getByRole("button", { name: "Make Work the default account" }).query()).toBeNull();

    await press(list.getByRole("button", { name: "Rename Second" }));
    const rename = page.getByRole("dialog", { name: "Rename Second" });
    await userEvent.clear(rename.getByLabelText("Account name"));
    await userEvent.type(rename.getByLabelText("Account name"), "Work");
    await expect.element(rename.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.clear(rename.getByLabelText("Account name"));
    await userEvent.type(rename.getByLabelText("Account name"), "  Personal ");
    await press(rename.getByRole("button", { name: "Save" }));
    await expect.element(list.getByText("Personal", { exact: true })).toBeVisible();
    await expect.element(rename).not.toBeInTheDocument();

    await press(list.getByRole("button", { name: "Make Personal the default account" }));
    await expect.element(screen.getByText("Ready", { exact: true })).toBeVisible();
    await expect
      .element(list.getByRole("button", { name: "Make Work the default account" }))
      .toBeVisible();

    await press(list.getByRole("button", { name: "Disconnect Personal" }));
    const replace = page.getByRole("dialog", { name: "Disconnect Personal?" });
    await expect.element(replace.getByRole("radio", { name: "Work" })).not.toBeChecked();
    await expect.element(replace.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    await press(replace.getByRole("radio", { name: "Work" }));
    await press(replace.getByRole("button", { name: "Disconnect" }));
    await expect.element(list.getByText("Personal", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText("Reconnect your Gmail account")).toBeVisible();
    expect(list.getByRole("button", { name: /^Make / }).query()).toBeNull();

    expect(changes(control.calls)).toEqual([
      {
        route: "PATCH /api/baskule/plugins/gmail/accounts/a2",
        body: { label: "Personal" },
        query: "",
      },
      { route: "PATCH /api/baskule/plugins/gmail/accounts/a2", body: { default: true }, query: "" },
      {
        route: "DELETE /api/baskule/plugins/gmail/accounts/a2",
        body: undefined,
        query: "?default=a1",
      },
    ]);
  });

  it("explains a refused account change in plain words", async () => {
    const control = fakeControl({
      "GET /api/baskule/plugins": () => ({
        plugins: [
          withAccounts("gmail", "Gmail", [
            account({ id: "a1", label: "Work" }),
            account({ id: "a2", label: "Second", default: false }),
          ]),
        ],
      }),
      "PATCH /api/baskule/plugins/gmail/accounts/a2": () =>
        Response.json({ error: "account_not_found" }, { status: 404 }),
    });
    using _fetch = control.stub;
    await using screen = await render(<UserPluginsView />);
    using add = vi.spyOn(toastManager, "add").mockReturnValue("toast");

    await press(screen.getByRole("button", { name: "Make Second the default account" }));
    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        type: "error",
        title: "Could not change your default account",
        description: "This account is no longer connected. Reload the page.",
      }),
    );
    await expect
      .element(screen.getByRole("button", { name: "Make Second the default account" }))
      .toBeEnabled();
  });

  it("explains a failed sign-in in plain words when the person comes back", async () => {
    const control = fakeControl({ "GET /api/baskule/plugins": () => ({ plugins: [] }) });
    using _fetch = control.stub;
    const back = new URL(window.location.href);
    back.searchParams.set("pluginConnection", "error");
    back.searchParams.set("connectionError", "invalid_oauth_state");
    window.history.replaceState(window.history.state, "", back);
    using add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await using _screen = await render(<UserPluginsView />);

    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        type: "error",
        title: "Could not connect your account",
        description:
          "This sign-in expired or was started in another browser. Start again from Settings → Plugins.",
      }),
    );
    expect(new URL(window.location.href).searchParams.has("connectionError")).toBe(false);
  });

  it("explains a sign-in refused before it started", async () => {
    const control = fakeControl({ "GET /api/baskule/plugins": () => ({ plugins: [] }) });
    using _fetch = control.stub;
    const back = new URL(window.location.href);
    back.searchParams.set("connectionError", "oauth_issuer_changed");
    window.history.replaceState(window.history.state, "", back);
    using add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await using _screen = await render(<UserPluginsView />);

    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        type: "error",
        title: "Could not connect your account",
        description:
          "This service now signs in somewhere other than where it was set up. Ask your admin to check its setup and save it again.",
      }),
    );
    expect(new URL(window.location.href).searchParams.has("connectionError")).toBe(false);
  });
});

describe("plugin errors", () => {
  it("never shows a raw code or message for an unknown error", () => {
    expect(pluginErrorText(new BaskuleApiError(400, "raw", "invalid_oauth_state"), "x")).toBe(
      "This sign-in expired or was started in another browser. Start again from Settings → Plugins.",
    );
    expect(pluginErrorText(new BaskuleApiError(500, "Boom", "other"), "x")).toBe("x");
    expect(pluginErrorText(new BaskuleApiError(500, "Boom", "constructor"), "x")).toBe("x");
    expect(pluginErrorText(new TypeError("Failed to fetch"), "x")).toBe("x");
  });
});
