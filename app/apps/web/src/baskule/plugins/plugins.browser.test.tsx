// baskule: the plugin screens against a fake ControlCell (fetch): what the admin adds, for whom,
// and pauses, and what a person is told about each plugin and can connect.
import type { Group, MemberPlugin, Plugin } from "@t3tools/contracts/baskule-plugins";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../../test/render";
import { toastManager } from "../../components/ui/toast";
import { BaskuleApiError } from "../api";
import { CatalogPage } from "../admin/plugins/CatalogPage";
import { AddOwnPluginDialog } from "../admin/plugins/AddOwnPluginDialog";
import { PluginDetailPage } from "../admin/plugins/PluginDetailPage";
import { pluginErrorText } from "./api";
import { UserPluginsView } from "./UserPluginsView";

type Route = (body: unknown) => unknown;

// Browser tests run without the app's CSS: dialog layers and switches are not hit-testable, so
// clicks go through the DOM, like the other browser tests of this app.
const press = (target: Locator) => act(() => (target.element() as HTMLElement).click());

/** A fetch answering `METHOD /path` (query ignored) from `routes`, recording each call. */
function fakeControl(routes: Record<string, Route>) {
  const calls: Array<{ readonly route: string; readonly body: unknown }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://test").pathname;
    const route = `${init?.method ?? "GET"} ${path}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ route, body });
    const handler = routes[route];
    return handler
      ? Response.json(handler(body))
      : Response.json({ error: "not_found" }, { status: 404 });
  });
  return { calls, stub: stubGlobal("fetch", fetch) };
}

const notion = {
  id: "com.notion/mcp",
  name: "Notion",
  description: "Pages and databases.",
  kind: "mcp" as const,
  source: { type: "registry" as const, registry: "mcp", id: "com.notion/mcp", version: "1" },
};
const brave = { ...notion, id: "com.brave/search", name: "Brave Search", description: "Search." };
const braveSource = { ...brave.source, id: brave.id };

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

function plugin(overrides: Partial<Plugin>): Plugin {
  return {
    id: "p1",
    name: "Plugin",
    description: "",
    source: { type: "url", url: "https://mcp.example.test/mcp" },
    skills: [],
    servers: [],
    ignored: [],
    enabled: true,
    createdAt: "2026-10-25T10:00:00Z",
    ...overrides,
  };
}

const postBody = (calls: ReadonlyArray<{ readonly route: string; readonly body: unknown }>) =>
  calls.find((call) => call.route === "POST /api/baskule/admin/plugins")?.body;

describe("admin catalog", () => {
  it("asks who can use a result before adding it, then reviews what it adds", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/plugins/search": () => ({
        results: [notion, { ...brave, source: braveSource }],
        failures: [{ registry: "codex-plugins", error: "unavailable" }],
      }),
      "GET /api/baskule/admin/plugins": () => ({
        plugins: [plugin({ id: "installed-brave", name: "Brave Search", source: braveSource })],
      }),
      "GET /api/baskule/admin/groups": () => ({ groups }),
      "POST /api/baskule/admin/plugins": () =>
        plugin({
          id: "new-notion",
          name: "Notion",
          source: notion.source,
          servers: [
            {
              name: "notion",
              url: "https://mcp.notion.com/mcp",
              credential: "user-oauth",
              personal: true,
            },
          ],
          ignored: ["hooks/hooks.json"],
        }),
    });
    using _fetch = control.stub;
    await using screen = await render(<CatalogPage />);

    await expect.element(screen.getByRole("button", { name: "Add Notion" })).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Brave Search is added: open it" }))
      .toHaveAttribute("href", "/admin/plugins/installed/installed-brave");
    await expect.element(screen.getByText(/OpenAI Codex plugins didn't answer/)).toBeVisible();

    await press(screen.getByRole("button", { name: "Add Notion" }));
    const choose = page.getByRole("dialog", { name: "Add Notion" });
    await expect.element(choose.getByRole("checkbox", { name: "Everyone" })).toBeChecked();
    await expect.element(choose.getByRole("checkbox", { name: "Sales" })).not.toBeChecked();
    expect(postBody(control.calls)).toBeUndefined();
    await press(choose.getByRole("checkbox", { name: "Sales" }));
    await press(choose.getByRole("button", { name: "Add plugin" }));

    const review = page.getByRole("dialog", { name: "Notion was added" });
    await expect.element(review.getByText("It is available to Everyone, Sales.")).toBeVisible();
    await expect.element(review.getByText("Tools from 1 server")).toBeVisible();
    await expect.element(review.getByText("1 part Baskule can't run")).toBeVisible();
    expect(postBody(control.calls)).toEqual({
      source: notion.source,
      groups: ["everyone", "sales"],
    });
  });
});

describe("adding your own plugin", () => {
  it("pins a git repository to a full commit and sends it for Everyone", async () => {
    const control = fakeControl({
      "POST /api/baskule/admin/plugins": () => plugin({ id: "git-plugin", name: "handbook" }),
    });
    using _fetch = control.stub;
    const onAdded = vi.fn();
    await using _screen = await render(
      <AddOwnPluginDialog open onOpenChange={() => undefined} onAdded={onAdded} groups={groups} />,
    );
    const dialog = page.getByRole("dialog", { name: "Add your own plugin" });
    await press(dialog.getByRole("button", { name: "Git repository" }));
    await userEvent.type(dialog.getByLabelText("Repository"), "https://github.com/acme/plugins");
    await userEvent.type(dialog.getByLabelText("Commit"), "abc123");
    await expect
      .element(dialog.getByText("Enter the full commit ID: 40 letters and digits."))
      .toBeVisible();
    await expect.element(dialog.getByRole("button", { name: "Add plugin" })).toBeDisabled();

    await userEvent.clear(dialog.getByLabelText("Commit"));
    await userEvent.type(
      dialog.getByLabelText("Commit"),
      "0123456789ABCDEF0123456789ABCDEF01234567",
    );
    await userEvent.type(dialog.getByLabelText("Folder (optional)"), "/skills/handbook/");
    await press(dialog.getByRole("button", { name: "Add plugin" }));

    await vi.waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: "git-plugin" }), [
        "everyone",
      ]),
    );
    expect(control.calls[0]?.body).toEqual({
      source: {
        type: "git",
        repo: "https://github.com/acme/plugins",
        ref: "0123456789abcdef0123456789abcdef01234567",
        path: "skills/handbook",
      },
      groups: ["everyone"],
    });
  });

  it("sends an uploaded file with the SHA-256 of its bytes, for no group when none is chosen", async () => {
    const control = fakeControl({
      "POST /api/baskule/admin/plugins": () => plugin({ id: "uploaded" }),
    });
    using _fetch = control.stub;
    const onAdded = vi.fn();
    await using _screen = await render(
      <AddOwnPluginDialog open onOpenChange={() => undefined} onAdded={onAdded} groups={groups} />,
    );
    const dialog = page.getByRole("dialog", { name: "Add your own plugin" });
    await press(dialog.getByRole("button", { name: "File" }));
    await userEvent.upload(
      dialog.getByLabelText("Plugin file"),
      new File(["hello"], "skill.zip", { type: "application/zip" }),
    );
    await press(dialog.getByRole("checkbox", { name: "Everyone" }));
    await expect
      .element(dialog.getByText("No one can use it until you choose a group on its page."))
      .toBeVisible();
    await press(dialog.getByRole("button", { name: "Add plugin" }));

    await vi.waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(control.calls[0]?.body).toEqual({
      source: {
        type: "archive",
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
      archive: "aGVsbG8=",
      groups: [],
    });
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
  const mine: MemberPlugin[] = [
    member({
      id: "drive",
      name: "Google Drive",
      status: "connect",
      servers: [{ name: "drive", status: "connect", personal: true }],
    }),
    member({
      id: "mail",
      name: "Mail",
      status: "reconnect",
      servers: [{ name: "mail", status: "reconnect", personal: true }],
    }),
    member({
      id: "search",
      name: "Search",
      status: "needs_setup",
      servers: [{ name: "search", status: "needs_setup", personal: false }],
    }),
    member({
      id: "sales",
      name: "Sales",
      status: "unavailable",
      skills: [{ name: "pipeline", description: "Pipeline reviews." }],
    }),
    member({
      id: "notes",
      name: "Notes",
      servers: [{ name: "notes", status: "ready", personal: true }],
    }),
    member({
      id: "wiki",
      name: "Wiki",
      servers: [{ name: "wiki", status: "ready", personal: false }],
    }),
  ];

  it("tells the status of each plugin and offers only the action it needs", async () => {
    let connected = true;
    const control = fakeControl({
      "GET /api/baskule/plugins": () => ({
        plugins: mine.map((entry) =>
          entry.id === "notes" && !connected
            ? { ...entry, status: "connect", servers: [{ ...entry.servers[0], status: "connect" }] }
            : entry,
        ),
      }),
      "DELETE /api/baskule/plugins/notes/connection": () => {
        connected = false;
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
    await expect
      .element(screen.getByRole("button", { name: "Reconnect your Mail account" }))
      .toBeEnabled();
    await expect
      .element(screen.getByText("Your administrator needs to finish setting it up"))
      .toBeVisible();
    await expect.element(screen.getByText("Not available to you")).toBeVisible();
    await expect.element(screen.getByText("Ready", { exact: true }).first()).toBeVisible();
    expect(screen.getByText("Ready", { exact: true }).all()).toHaveLength(2);
    expect(screen.getByRole("switch").query()).toBeNull();
    expect(screen.getByRole("button", { name: /^(Connect|Reconnect) your/ }).all()).toHaveLength(2);
    // An organization's key is not the person's to disconnect.
    expect(screen.getByRole("button", { name: "Disconnect your Wiki account" }).query()).toBeNull();

    await press(screen.getByRole("button", { name: "Disconnect your Notes account" }));
    await expect.element(screen.getByText("Connect your Notes account")).toBeVisible();
    expect(screen.getByText("Ready", { exact: true }).all()).toHaveLength(1);
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
