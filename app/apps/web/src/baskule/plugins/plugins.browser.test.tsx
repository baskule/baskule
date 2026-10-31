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
import { pluginErrorText, pluginsApi } from "./api";
import { UserPluginsView } from "./UserPluginsView";

type Route = (body: unknown, query: URLSearchParams) => unknown;

// Browser tests run without the app's CSS: dialog layers and switches are not hit-testable, so
// clicks go through the DOM, like the other browser tests of this app.
const press = (target: Locator) => act(() => (target.element() as HTMLElement).click());

/** Opens an account's options menu and chooses one of them. */
async function chooseAccountOption(
  scope: Pick<Locator, "getByRole">,
  account: string,
  option: string,
) {
  await press(scope.getByRole("button", { name: `Options for ${account}`, exact: true }));
  await press(page.getByRole("menuitem", { name: option, exact: true }));
}

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
      .element(screen.getByRole("button", { name: "Linear", exact: true }))
      .toHaveAccessibleDescription("Ready in one click");
    await expect
      .element(screen.getByRole("button", { name: "Gmail", exact: true }))
      .toHaveAccessibleDescription("Needs setup");
    for (const held of ["Figma", "Shopify", "Docusign", "Microsoft Teams"]) {
      expect(screen.getByRole("button", { name: `Add ${held}` }).query()).toBeNull();
    }
    // What a service needs stays off the list until its entry is opened.
    expect(screen.getByText(/Workspace MCP Developer Preview/).query()).toBeNull();

    const figma = screen.getByRole("button", { name: "Figma", exact: true });
    await expect.element(figma).toHaveAccessibleDescription("Not available yet");
    await press(figma);
    const held = page.getByRole("dialog", { name: "Figma" });
    await expect
      .element(held.getByText("Figma must first add Baskule to its list of approved apps."))
      .toBeVisible();
    expect(held.getByRole("button", { name: "Add plugin" }).query()).toBeNull();
    await press(held.getByText("Close", { exact: true }));
    await expect.element(held).not.toBeInTheDocument();

    await press(screen.getByRole("button", { name: "Add Linear" }));
    const choose = page.getByRole("dialog", { name: "Add Linear" });
    await expect
      .element(choose.getByRole("link", { name: "Linear documentation" }))
      .toHaveAttribute("target", "_blank");
    await expect.element(choose.getByRole("checkbox", { name: "Everyone" })).toBeChecked();
    await expect.element(choose.getByRole("checkbox", { name: "Sales" })).not.toBeChecked();
    expect(postBody(control.calls)).toBeUndefined();
    await press(choose.getByRole("checkbox", { name: "Sales" }));
    await press(choose.getByRole("button", { name: "Add plugin" }));

    const added = screen.getByRole("link", { name: "Linear", exact: true });
    await expect.element(added).toHaveAttribute("href", "/admin/plugins/installed/linear");
    await expect.element(added).toHaveAccessibleDescription("Added");
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

    const gmail = screen.getByRole("link", { name: "Gmail", exact: true });
    await expect.element(gmail).toHaveAttribute("href", "/admin/plugins/installed/gmail");
    await expect.element(gmail).toHaveAccessibleDescription("Needs setup");
    await expect
      .element(screen.getByRole("link", { name: "Linear", exact: true }))
      .toHaveAccessibleDescription("Added");
    expect(screen.getByRole("button", { name: "Add Gmail" }).query()).toBeNull();
    await expect.element(screen.getByRole("button", { name: "Add Google Calendar" })).toBeVisible();
  });
  it("counts a vendor's app saved for one service as setup for its other services", async () => {
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
            setup: [{ server: "gmail", done: true }],
            vendorConfigured: true,
          }),
        ],
      }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
    });
    using _fetch = control.stub;
    await using screen = await render(<CatalogPage />);

    const calendar = screen.getByRole("button", { name: "Google Calendar", exact: true });
    await expect.element(calendar).toHaveAccessibleDescription("Ready in one click");
    await expect
      .element(screen.getByRole("button", { name: "Slack", exact: true }))
      .toHaveAccessibleDescription("Needs setup");
    await press(screen.getByRole("button", { name: "Add Google Calendar" }));
    const choose = page.getByRole("dialog", { name: "Add Google Calendar" });
    await expect.element(choose.getByRole("checkbox", { name: "Everyone" })).toBeChecked();
    expect(
      choose.getByText("After you add it, finish setting it up on its page.").query(),
    ).toBeNull();
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
    expect(screen.getByText("commands/forecast.md").query()).toBeNull();
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

  it("does not carry a key or switched-off tools to a replacement server given the old one's name", async () => {
    const initial = {
      name: "Notes",
      description: "",
      source: { type: "custom" as const },
      skills: [],
      omitted: [],
      servers: [
        {
          name: "notes",
          url: "https://notes.example.test/mcp",
          transport: "streamable-http" as const,
          credential: "organization" as const,
          keyHeaders: ["X-Api-Key"],
          disabledTools: ["delete_note"],
        },
      ],
    };
    const onSaved = vi.fn();
    const control = fakeControl({
      "POST /api/baskule/admin/plugins/test": () => ({ tools: notesTools }),
      "PATCH /api/baskule/admin/plugins/p1": () => plugin({}),
      "PUT /api/baskule/admin/plugins/p1/secret": () => ({ ok: true }),
    });
    using _fetch = control.stub;
    await using screen = await render(
      <PluginEditor
        initial={initial}
        fixes={[]}
        omitted={[]}
        target={{ type: "edit", id: "p1", savedKeys: new Set(["notes"]), versions: [] }}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
      // This standalone form has no routing or navigation.
      { router: false },
    );
    await userEvent.type(screen.getByLabelText("Key", { exact: true }), "notes-key");
    await press(screen.getByRole("button", { name: "JSON", exact: true }));
    const calendar = (name: string) =>
      JSON.stringify({
        mcpServers: {
          [name]: {
            url: "https://calendar.example.test/mcp",
            headers: { "X-Api-Key": "${X_API_KEY}" },
          },
        },
      });
    await userEvent.fill(jsonBox(), calendar("calendar"));
    await userEvent.fill(jsonBox(), calendar("notes"));
    await press(screen.getByRole("button", { name: "Form", exact: true }));

    await expect.element(screen.getByLabelText("Key", { exact: true })).toHaveValue("");
    await userEvent.type(screen.getByLabelText("Key", { exact: true }), "calendar-key");
    await press(screen.getByRole("button", { name: "Test connection" }));
    await expect.element(screen.getByRole("switch", { name: "Allow delete_note" })).toBeChecked();
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    const { disabledTools: _notes, ...server } = {
      ...initial.servers[0]!,
      url: "https://calendar.example.test/mcp",
    };
    expect(
      control.calls
        .filter((call) => !call.route.startsWith("GET "))
        .map((call) => [call.route, call.body]),
    ).toEqual([
      [
        "POST /api/baskule/admin/plugins/test",
        { server, headers: { "X-Api-Key": "calendar-key" } },
      ],
      ["PATCH /api/baskule/admin/plugins/p1", { plugin: { ...initial, servers: [server] } }],
      [
        "PUT /api/baskule/admin/plugins/p1/secret",
        { server: "notes", headers: { "X-Api-Key": "calendar-key" } },
      ],
    ]);
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

  it("shows a test's tools when it finishes while the server's name is retyped in the JSON", async () => {
    let answer: (result: unknown) => void = () => {};
    const control = fakeControl({
      "POST /api/baskule/admin/plugins/test": () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    using _fetch = control.stub;
    await using screen = await render(
      <PluginEditor
        initial={{ ...fixtures, servers: fixtures.servers.slice(0, 1) }}
        fixes={[]}
        omitted={[]}
        target={{ type: "create", groups, groupsError: null }}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
      // This standalone form has no routing or navigation.
      { router: false },
    );
    using tested = vi.spyOn(pluginsApi, "test");
    await userEvent.type(screen.getByLabelText("Key", { exact: true }), "fixture-key");
    await press(screen.getByRole("button", { name: "Test connection" }));
    await expect.element(screen.getByRole("button", { name: "Save plugin" })).toBeDisabled();
    await press(screen.getByRole("button", { name: "JSON", exact: true }));
    const text = () => (jsonBox().element() as HTMLTextAreaElement).value;
    const start = text().indexOf('"fixture"') + 1;
    await deleteJson(start, start + "fixture".length);
    await vi.waitFor(() => expect(text()).toContain('"": {'));
    // The test finishes while the JSON describes no server.
    await act(async () => {
      answer({ tools: fixtureTools });
      await tested.mock.results[0]?.value;
    });
    await userEvent.keyboard("fixture");
    await press(screen.getByRole("button", { name: "Form", exact: true }));

    await expect.element(screen.getByRole("switch", { name: "Allow fixture_write" })).toBeChecked();
    await expect.element(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
    await expect.element(screen.getByRole("button", { name: "Save plugin" })).toBeEnabled();
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
        target={{ type: "edit", id: "p1", savedKeys: new Set(["crm"]), versions: [] }}
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
        target={{ type: "edit", id: "p1", savedKeys: new Set(), versions: [] }}
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

    const steps = screen.getByRole("list", { name: "Setup steps" });
    await expect.element(steps.getByText("Create an app at Google (to do)")).toBeVisible();
    await expect
      .element(steps.getByText("Save the app's ID and secret here (to do)"))
      .toBeVisible();
    expect(screen.getByLabelText("How gmail signs in", { exact: true }).query()).toBeNull();
    await expect
      .element(screen.getByText(/Each person connects their own account in Settings → Plugins/))
      .toBeVisible();
    await expect.element(screen.getByText(/Workspace MCP Developer Preview/)).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Gmail documentation" }))
      .toHaveAttribute("target", "_blank");
    // The callback address and the server's host wait under Technical details.
    await expect
      .element(screen.getByLabelText("Callback address", { exact: true }))
      .not.toBeVisible();
    await expect
      .element(screen.getByText("https://gmailmcp.googleapis.com/mcp/v1"))
      .not.toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Copy Baskule's address" }))
      .toBeVisible();
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
        versions: [],
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
        target={{ type: "edit", id: "p1", savedKeys: new Set(["crm"]), versions: [] }}
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
        target={{ type: "edit", id: "p1", savedKeys: new Set(["crm"]), versions: [] }}
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
        target={{ type: "edit", id: "p1", savedKeys: new Set(["crm"]), versions: [] }}
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

    const steps = screen.getByRole("list", { name: "Setup steps" });
    await expect.element(steps.getByText("Create an app at CRM (to do)")).toBeInTheDocument();
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

    await expect
      .element(screen.getByText("Saved. People sign in to CRM through this app."))
      .toBeVisible();
    await expect.element(steps.getByText("Create an app at CRM (done)")).toBeInTheDocument();
    // Saved secrets are never shown back: the form is gone until the admin replaces the app.
    expect(screen.getByLabelText("Client ID", { exact: true }).query()).toBeNull();
    expect(
      screen.getByText("People can't use it until you finish setting it up below.").query(),
    ).toBeNull();
    await press(screen.getByRole("button", { name: "Replace the app at CRM" }));
    await expect.element(screen.getByLabelText("Client ID", { exact: true })).toHaveValue("");
    await press(screen.getByRole("button", { name: "Cancel" }));

    await press(screen.getByRole("button", { name: "Remove setup" }));
    await expect.element(steps.getByText("Create an app at CRM (to do)")).toBeInTheDocument();
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

describe("writing skills", () => {
  const crmServer = { name: "crm", url: "https://mcp.crm.example.test/mcp", disabledTools: [] };
  const writeControl = () =>
    fakeControl({
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins": () => plugin({ id: "skill-plugin" }),
    });
  async function startSkill() {
    await press(page.getByRole("button", { name: "New skill" }));
    await expect.element(page.getByLabelText("Skill name", { exact: true })).toBeVisible();
  }
  const skillName = () => page.getByLabelText("Skill name", { exact: true });
  const skillDescription = () => page.getByLabelText("Skill description", { exact: true });

  it("checks a new skill's name and description as they are typed and saves nothing until they follow the rules", async () => {
    const control = writeControl();
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await startSkill();

    await userEvent.type(skillName(), "Call Prep");
    await expect
      .element(
        screen.getByText("Use only lowercase letters, numbers and single hyphens, like call-prep."),
      )
      .toBeVisible();
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await expect
      .element(screen.getByText("Say what the skill does and when to use it."))
      .toBeVisible();
    expect(postBody(control.calls)).toBeUndefined();

    await userEvent.clear(skillName());
    await userEvent.type(skillName(), "call-prep");
    await userEvent.type(skillDescription(), "Prepare a sales call.");
    await press(screen.getByRole("button", { name: "Add a skill" }));
    await userEvent.type(skillName().nth(1), "call-prep");
    await expect
      .element(screen.getByText("Another skill in this plugin has this name.").first())
      .toBeVisible();
    await press(
      screen.getByRole("group", { name: "call-prep" }).nth(1).getByRole("button", {
        name: "Remove skill",
      }),
    );
    expect(
      screen
        .getByText("Use only lowercase letters, numbers and single hyphens, like call-prep.")
        .query(),
    ).toBeNull();
    await expect
      .element(screen.getByText("Leave empty to use the skill's name and description."))
      .toBeVisible();
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() =>
      expect(postBody(control.calls)).toEqual({
        plugin: {
          name: "call-prep",
          description: "Prepare a sales call.",
          source: { type: "custom" },
          servers: [],
          skills: [
            {
              name: "call-prep",
              description: "Prepare a sales call.",
              instructions: "",
              files: [],
            },
          ],
          omitted: [],
        },
        groups: ["everyone"],
      }),
    );
  });

  it("previews the instructions as Markdown and shows HTML in them as text", async () => {
    using _fetch = writeControl().stub;
    await using screen = await render(<AddOwnPage />);
    await startSkill();
    const text = "# Steps\n\nWrite **short** notes. <img src=x onerror=alert(1)>";
    await userEvent.fill(screen.getByLabelText("Instructions", { exact: true }), text);
    await press(screen.getByRole("button", { name: "Preview" }));

    const preview = screen.getByRole("region", { name: "Preview of the instructions" });
    await expect.element(preview.getByRole("heading", { name: "Steps" })).toBeVisible();
    expect(preview.element().querySelector("strong")?.textContent).toBe("short");
    expect(preview.element().querySelector("img")).toBeNull();
    expect(preview.element().textContent).toContain("<img src=x onerror=alert(1)>");

    await press(screen.getByRole("button", { name: "Write" }));
    await expect.element(screen.getByLabelText("Instructions", { exact: true })).toHaveValue(text);
  });

  it("adds, renames and removes a skill's files, keeping their bytes exactly", async () => {
    const control = writeControl();
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await startSkill();
    await userEvent.type(skillName(), "tools");
    await userEvent.type(skillDescription(), "Run the team's tools.");
    await userEvent.upload(screen.getByLabelText("Add files"), [
      new File([new Uint8Array([0, 255, 128, 10])], "run.bin"),
      new File(["# Notes\n"], "notes.md"),
      new File(["old"], "old.txt"),
    ]);
    await expect.element(screen.getByLabelText("Path of file 3")).toHaveValue("old.txt");
    await expect.element(screen.getByText("4 B", { exact: true })).toBeVisible();

    await press(screen.getByRole("button", { name: "Remove old.txt" }));
    await userEvent.fill(screen.getByLabelText("Path of file 2"), "run.bin");
    await expect
      .element(screen.getByText("Another file has this path. Rename one of them.").first())
      .toBeVisible();
    await press(screen.getByRole("button", { name: "Save plugin" }));
    expect(postBody(control.calls)).toBeUndefined();

    await userEvent.fill(screen.getByLabelText("Path of file 2"), "refs/notes.md");
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await vi.waitFor(() =>
      expect(
        (postBody(control.calls) as { plugin: PluginInput } | undefined)?.plugin.skills[0]?.files,
      ).toEqual([
        { path: "run.bin", content: "AP+ACg==", encoding: "base64" },
        { path: "refs/notes.md", content: btoa("# Notes\n"), encoding: "base64" },
      ]),
    );
  });

  it("waits for selected file reads before saving all of their bytes", async () => {
    const control = writeControl();
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await startSkill();
    await userEvent.fill(skillName(), "notes");
    await userEvent.fill(skillDescription(), "Write notes.");
    let finish: ((value: ArrayBuffer) => void) | undefined;
    using _read = vi.spyOn(File.prototype, "arrayBuffer");
    screen
      .getByLabelText("Add files")
      .element()
      .addEventListener(
        "change",
        () => {
          _read.mockImplementation(
            () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
          );
        },
        { capture: true, once: true },
      );
    await userEvent.upload(
      screen.getByLabelText("Add files"),
      new File([new Uint8Array([0, 255, 10])], "notes.bin"),
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    try {
      await expect.element(screen.getByRole("button", { name: "Save plugin" })).toBeDisabled();
      screen
        .getByLabelText("Skill name", { exact: true })
        .element()
        .closest("form")!
        .requestSubmit();
      expect(postBody(control.calls)).toBeUndefined();
    } finally {
      finish!(new Uint8Array([0, 255, 10]).buffer);
    }
    await expect.element(screen.getByLabelText("Path of file 1")).toHaveValue("notes.bin");
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await vi.waitFor(() =>
      expect((postBody(control.calls) as { plugin: PluginInput })?.plugin.skills[0]?.files).toEqual(
        [{ path: "notes.bin", content: "AP8K", encoding: "base64" }],
      ),
    );
  });

  it("waits for file reads before reverting and confirms discarding the selected file", async () => {
    const skill = {
      name: "notes",
      description: "Write notes.",
      instructions: "Current notes.",
      files: [],
    };
    const control = fakeControl({
      "POST /api/baskule/admin/plugins/p1/versions/1/revert": () => ({
        skills: [{ ...skill, instructions: "Earlier notes." }],
        editable: true,
        versions: [],
      }),
    });
    using _fetch = control.stub;
    const confirm = vi.fn(() => true);
    using _confirm = stubGlobal("confirm", confirm);
    await using screen = await render(
      <PluginEditor
        initial={{
          name: "Notes",
          description: "",
          source: { type: "custom" },
          skills: [skill],
          servers: [],
          omitted: [],
        }}
        fixes={[]}
        omitted={[]}
        target={{
          type: "edit",
          id: "p1",
          savedKeys: new Set(),
          versions: [{ version: 1, savedAt: "2026-10-30T09:00:00Z" }],
        }}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );
    await press(
      screen.getByRole("group", { name: "notes" }).getByRole("button", { expanded: false }),
    );
    let finish: ((value: ArrayBuffer) => void) | undefined;
    using _read = vi.spyOn(File.prototype, "arrayBuffer");
    screen
      .getByLabelText("Add files")
      .element()
      .addEventListener(
        "change",
        () => {
          _read.mockImplementation(
            () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
          );
        },
        { capture: true, once: true },
      );
    await userEvent.upload(screen.getByLabelText("Add files"), new File(["new"], "notes.txt"));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    try {
      await expect
        .element(screen.getByRole("button", { name: "Revert to version 1" }))
        .toBeDisabled();
    } finally {
      finish!(new TextEncoder().encode("new").buffer);
    }
    await expect.element(screen.getByLabelText("Path of file 1")).toHaveValue("notes.txt");
    await press(screen.getByRole("button", { name: "Revert to version 1" }));
    await vi.waitFor(() =>
      expect(control.calls.filter((call) => call.route.endsWith("/revert"))).toHaveLength(1),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("skill changes you haven't saved"),
    );
  });

  it("shows a file read failure and lets the file be selected again", async () => {
    const control = writeControl();
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await startSkill();
    await userEvent.fill(skillName(), "notes");
    await userEvent.fill(skillDescription(), "Write notes.");
    const read = File.prototype.arrayBuffer;
    using _read = vi.spyOn(File.prototype, "arrayBuffer");
    screen
      .getByLabelText("Add files")
      .element()
      .addEventListener(
        "change",
        () => {
          _read.mockRejectedValue(new Error("unreadable file"));
        },
        { capture: true, once: true },
      );
    await userEvent.upload(screen.getByLabelText("Add files"), new File(["notes"], "notes.txt"));
    await expect
      .element(screen.getByText("The files could not be read. Add them again."))
      .toBeVisible();
    expect(postBody(control.calls)).toBeUndefined();
    _read.mockImplementation(read);
    await userEvent.upload(screen.getByLabelText("Add files"), new File(["notes"], "notes.txt"));
    await expect.element(screen.getByLabelText("Path of file 1")).toHaveValue("notes.txt");
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await vi.waitFor(() =>
      expect((postBody(control.calls) as { plugin: PluginInput })?.plugin.skills[0]?.files).toEqual(
        [{ path: "notes.txt", content: btoa("notes"), encoding: "base64" }],
      ),
    );
  });

  it("locks pinned skills once creation succeeds so a failed key write can be retried", async () => {
    const source = {
      type: "github" as const,
      repo: "https://github.com/example/skills",
      sha: "a".repeat(40),
    };
    let refuse = true;
    const control = fakeControl({
      "POST /api/baskule/admin/plugins": () => plugin({ id: "imported", source }),
      "PATCH /api/baskule/admin/plugins/imported": () => plugin({ id: "imported", source }),
      "PUT /api/baskule/admin/plugins/imported/secret": () => {
        if (!refuse) return { ok: true };
        refuse = false;
        return Response.json({ error: "invalid_secret_headers" }, { status: 400 });
      },
    });
    using _fetch = control.stub;
    await using screen = await render(
      <PluginEditor
        initial={{
          name: "Imported",
          description: "",
          source,
          omitted: [],
          servers: [
            {
              name: "crm",
              url: "https://crm.example.test/mcp",
              credential: "organization",
              keyHeaders: ["Authorization"],
            },
          ],
          skills: [
            {
              name: "notes",
              description: "Write notes.",
              instructions: "Published notes.",
              files: [],
            },
          ],
        }}
        fixes={[]}
        omitted={[]}
        target={{ type: "create", groups, groupsError: null }}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );
    await press(
      screen.getByRole("group", { name: "notes" }).getByRole("button", { expanded: false }),
    );
    await userEvent.fill(
      screen.getByLabelText("Instructions", { exact: true }),
      "First-save edits.",
    );
    await userEvent.fill(screen.getByLabelText("Key", { exact: true }), "Bearer key");
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await expect.element(screen.getByText(/was saved, but its key was not/)).toBeVisible();
    expect(screen.getByLabelText("Instructions", { exact: true }).query()).toBeNull();
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await vi.waitFor(() =>
      expect(control.calls.filter((call) => call.route.endsWith("/secret"))).toHaveLength(2),
    );
    expect(
      control.calls.filter((call) => !call.route.startsWith("GET ")).map((call) => call.route),
    ).toEqual([
      "POST /api/baskule/admin/plugins",
      "PUT /api/baskule/admin/plugins/imported/secret",
      "PATCH /api/baskule/admin/plugins/imported",
      "PUT /api/baskule/admin/plugins/imported/secret",
    ]);
  });

  it("warns about what may not work outside Claude Code and saves anyway", async () => {
    const control = writeControl();
    using _fetch = control.stub;
    await using screen = await render(<AddOwnPage />);
    await startSkill();
    await userEvent.type(skillName(), "deploy");
    await userEvent.type(skillDescription(), "Deploy the site.");
    await userEvent.fill(
      screen.getByLabelText("Instructions", { exact: true }),
      "Run npm install first.\n/deploy the site.",
    );
    await userEvent.upload(
      screen.getByLabelText("Add files"),
      new File(["API_KEY=abcdefgh12345\n"], ".env"),
    );

    await expect.element(screen.getByText("Things to check")).toBeVisible();
    for (const warning of [
      "The instructions use a slash command, which Baskule may not have.",
      "The instructions ask to install software. The computer may need setting up first.",
      ".env may contain a password or key. Remove it before sharing the skill.",
      "You can still save this skill.",
    ]) {
      await expect.element(screen.getByText(warning)).toBeVisible();
    }
    expect(screen.getByText(/abcdefgh12345/).query()).toBeNull();
    await press(screen.getByRole("button", { name: "Save plugin" }));
    await vi.waitFor(() => expect(postBody(control.calls)).toBeDefined());
  });

  it("reverts every skill to an earlier version at once and leaves servers and other edits alone", async () => {
    const current = {
      name: "notes",
      description: "Write notes.",
      instructions: "Version three.",
      files: [],
    };
    const earlier = {
      name: "notes",
      description: "Write short notes.",
      instructions: "Version one.",
      frontmatter: "license: MIT\n",
      files: [{ path: "template.md", content: btoa("# Notes\n"), encoding: "base64" as const }],
    };
    const server = {
      ...crmServer,
      credential: "none" as const,
      transport: "streamable-http" as const,
    };
    const control = fakeControl({
      "GET /api/baskule/admin/plugins": () => ({
        plugins: [
          plugin({
            name: "Notes",
            servers: [server],
            skills: [{ name: "notes", description: "Write notes." }],
            setup: [{ server: "crm", done: true }],
          }),
        ],
      }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "GET /api/baskule/admin/plugins/p1/skills": () => ({
        skills: [current],
        editable: true,
        versions: [
          { version: 2, savedAt: "2026-10-30T09:00:00Z", savedBy: "Ada" },
          { version: 1, savedAt: "2026-10-29T09:00:00Z" },
        ],
      }),
      "POST /api/baskule/admin/plugins/p1/versions/1/revert": () => ({
        skills: [earlier],
        editable: true,
        versions: [
          { version: 3, savedAt: "2026-10-31T09:00:00Z", savedBy: "Ada" },
          { version: 2, savedAt: "2026-10-30T09:00:00Z", savedBy: "Ada" },
          { version: 1, savedAt: "2026-10-29T09:00:00Z" },
        ],
      }),
      "PATCH /api/baskule/admin/plugins/p1": () => plugin({}),
    });
    using _fetch = control.stub;
    const confirm = vi.fn(() => true);
    using _confirm = stubGlobal("confirm", confirm);
    await using screen = await render(<PluginDetailPage id="p1" />);
    await press(screen.getByRole("button", { name: "Edit Notes" }));

    await expect
      .element(
        screen.getByText(
          "Reverting restores this plugin's skills. Its servers and keys stay as they are.",
        ),
      )
      .toBeVisible();
    await userEvent.fill(screen.getByLabelText("Name", { exact: true }), "Team notes");
    await press(screen.getByRole("button", { name: /^notes/ }));
    await userEvent.fill(skillDescription(), "Changed, not saved.");
    await press(screen.getByRole("button", { name: "Revert to version 1" }));

    await expect
      .element(screen.getByText(/^The skills of version 1 are back and saved\./))
      .toBeVisible();
    expect(confirm).toHaveBeenCalledOnce();
    await expect.element(screen.getByText("Write short notes.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Revert to version 3" })).toBeVisible();
    await expect.element(screen.getByLabelText("Name", { exact: true })).toHaveValue("Team notes");
    expect(
      control.calls.filter((call) => call.route === "GET /api/baskule/admin/plugins"),
    ).toHaveLength(2);
    expect(control.calls.some((call) => call.route.startsWith("PATCH "))).toBe(false);

    await press(screen.getByRole("button", { name: "Save plugin" }));
    const { disabledTools: _unchanged, ...unchangedServer } = server;
    await vi.waitFor(() =>
      expect(
        control.calls.find((call) => call.route === "PATCH /api/baskule/admin/plugins/p1")?.body,
      ).toEqual({
        plugin: {
          name: "Team notes",
          description: "",
          source: { type: "custom" },
          servers: [unchangedServer],
          skills: [earlier],
          omitted: [],
        },
      }),
    );
  });

  it("keeps a GitHub plugin's skills as published and copies them into a plugin of the admin's own", async () => {
    const pinned = {
      name: "call-prep",
      description: "Prepare a call.",
      instructions: "Use the CRM.",
      frontmatter: "license: Apache-2.0\n",
      files: [
        { path: "templates/brief.md", content: btoa("# Brief\n"), encoding: "base64" as const },
      ],
    };
    const control = fakeControl({
      "GET /api/baskule/admin/plugins": () => ({
        plugins: [
          plugin({
            name: "Sales",
            description: "Sales calls.",
            source: {
              type: "github",
              repo: "https://github.com/acme/plugins",
              sha: "0123456789abcdef0123456789abcdef01234567",
              path: "sales",
            },
            servers: [
              { ...crmServer, credential: "none", transport: "streamable-http", disabledTools: [] },
            ],
            skills: [{ name: pinned.name, description: pinned.description }],
            setup: [{ server: "crm", done: true }],
          }),
        ],
      }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "GET /api/baskule/admin/plugins/p1/skills": () => ({
        skills: [pinned],
        editable: false,
        versions: [],
      }),
      "POST /api/baskule/admin/plugins": () => plugin({ id: "copy-1" }),
    });
    using _fetch = control.stub;
    await using screen = await render(<PluginDetailPage id="p1" />);

    await press(screen.getByRole("button", { name: "Edit Sales" }));
    await expect
      .element(
        screen.getByText(
          "These skills stay as published. To change them, make your own copy from the plugin's page.",
        ),
      )
      .toBeVisible();
    expect(screen.getByLabelText("Skill name", { exact: true }).query()).toBeNull();
    expect(screen.getByText("Earlier versions").query()).toBeNull();
    await press(screen.getByRole("button", { name: "Cancel" }));

    await expect
      .element(screen.getByText("Its skills stay as published. Make your own copy to change them."))
      .toBeVisible();
    await press(screen.getByRole("button", { name: "Make your own copy" }));
    await expect
      .element(screen.getByRole("heading", { name: "Make your own copy of Sales" }))
      .toBeVisible();
    await expect
      .element(screen.getByLabelText("Name", { exact: true }))
      .toHaveValue("Copy of Sales");
    await expect.element(screen.getByRole("checkbox", { name: "Everyone" })).toBeChecked();
    await press(screen.getByRole("button", { name: /^call-prep/ }));
    await userEvent.fill(
      screen.getByLabelText("Instructions", { exact: true }),
      "Use the CRM, then email.",
    );
    await press(screen.getByRole("button", { name: "Save plugin" }));

    await vi.waitFor(() =>
      expect(postBody(control.calls)).toEqual({
        plugin: {
          name: "Copy of Sales",
          description: "Sales calls.",
          source: { type: "custom" },
          servers: [],
          skills: [{ ...pinned, instructions: "Use the CRM, then email." }],
          omitted: [],
        },
        groups: ["everyone"],
      }),
    );
    expect(control.calls.some((call) => call.route.startsWith("PATCH "))).toBe(false);
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
    expect(screen.getByRole("button", { name: /^Options for / }).all()).toHaveLength(2);

    await chooseAccountOption(screen, "Notes", "Disconnect…");
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

    const row = (label: string) => list.getByRole("listitem").filter({ hasText: label });
    await expect.element(screen.getByText("Reconnect your Gmail account")).toBeVisible();
    await expect.element(row("Work").getByText("Default", { exact: true })).toBeVisible();

    await chooseAccountOption(list, "Second", "Rename…");
    const rename = page.getByRole("dialog", { name: "Rename Second" });
    await userEvent.clear(rename.getByLabelText("Account name"));
    await userEvent.type(rename.getByLabelText("Account name"), "Work");
    await expect.element(rename.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.clear(rename.getByLabelText("Account name"));
    await userEvent.type(rename.getByLabelText("Account name"), "  Personal ");
    await press(rename.getByRole("button", { name: "Save" }));
    await expect.element(list.getByText("Personal", { exact: true })).toBeVisible();
    await expect.element(rename).not.toBeInTheDocument();

    await chooseAccountOption(list, "Personal", "Make default");
    await expect.element(screen.getByText("Ready", { exact: true })).toBeVisible();
    await expect.element(row("Personal").getByText("Default", { exact: true })).toBeVisible();
    expect(row("Work").getByText("Default", { exact: true }).query()).toBeNull();

    await chooseAccountOption(list, "Personal", "Disconnect…");
    const replace = page.getByRole("dialog", { name: "Disconnect Personal?" });
    await expect.element(replace.getByRole("radio", { name: "Work" })).not.toBeChecked();
    await expect.element(replace.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    await press(replace.getByRole("radio", { name: "Work" }));
    await press(replace.getByRole("button", { name: "Disconnect" }));
    await expect.element(list.getByText("Personal", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText("Reconnect your Gmail account")).toBeVisible();
    await expect.element(row("Work").getByText("Default", { exact: true })).toBeVisible();

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

    await chooseAccountOption(screen, "Second", "Make default");
    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        type: "error",
        title: "Could not change your default account",
        description: "This account is no longer connected. Reload the page.",
      }),
    );
    await expect.element(screen.getByRole("button", { name: "Options for Second" })).toBeEnabled();
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
