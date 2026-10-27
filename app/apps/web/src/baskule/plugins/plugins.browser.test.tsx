// baskule: the plugin screens against a fake ControlCell (fetch): what the admin adds and sees,
// and what a person can switch and connect.
import type { Plugin, UserPlugin } from "@t3tools/contracts/baskule-plugins";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../../test/render";
import { CatalogPage } from "../admin/plugins/CatalogPage";
import { AddOwnPluginDialog } from "../admin/plugins/AddOwnPluginDialog";
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

function plugin(overrides: Partial<Plugin>): Plugin {
  return {
    id: "p1",
    kind: "mcp",
    name: "Plugin",
    description: "",
    source: { type: "url", url: "https://mcp.example.test/mcp" },
    skills: [],
    servers: [],
    ignored: [],
    enabled: false,
    createdAt: "2026-10-25T10:00:00Z",
    ...overrides,
  };
}

describe("admin catalog", () => {
  it("opens plugins already added, names silent registries, and reviews what it adds", async () => {
    const control = fakeControl({
      "GET /api/baskule/admin/plugins/search": () => ({
        results: [notion, { ...brave, source: braveSource }],
        failures: [{ registry: "codex-plugins", error: "unavailable" }],
      }),
      "GET /api/baskule/admin/plugins": () => ({
        plugins: [plugin({ id: "installed-brave", name: "Brave Search", source: braveSource })],
      }),
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
    const review = page.getByRole("dialog", { name: "Notion was added" });
    await expect.element(review.getByText("1 connector")).toBeVisible();
    await expect.element(review.getByText("1 part Baskule can't run")).toBeVisible();
    expect(
      control.calls.find((call) => call.route === "POST /api/baskule/admin/plugins")?.body,
    ).toEqual({
      source: notion.source,
    });
  });
});

describe("adding your own plugin", () => {
  it("pins a git repository to a full commit before sending it", async () => {
    const control = fakeControl({
      "POST /api/baskule/admin/plugins": () => plugin({ id: "git-plugin", name: "handbook" }),
    });
    using _fetch = control.stub;
    const onAdded = vi.fn();
    await using _screen = await render(
      <AddOwnPluginDialog open onOpenChange={() => undefined} onAdded={onAdded} />,
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
      expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: "git-plugin" })),
    );
    expect(control.calls[0]?.body).toEqual({
      source: {
        type: "git",
        repo: "https://github.com/acme/plugins",
        ref: "0123456789abcdef0123456789abcdef01234567",
        path: "skills/handbook",
      },
    });
  });

  it("sends an uploaded file with the SHA-256 of its bytes", async () => {
    const control = fakeControl({
      "POST /api/baskule/admin/plugins": () => plugin({ id: "uploaded" }),
    });
    using _fetch = control.stub;
    const onAdded = vi.fn();
    await using _screen = await render(
      <AddOwnPluginDialog open onOpenChange={() => undefined} onAdded={onAdded} />,
    );
    const dialog = page.getByRole("dialog", { name: "Add your own plugin" });
    await press(dialog.getByRole("button", { name: "File" }));
    await userEvent.upload(
      dialog.getByLabelText("Plugin file"),
      new File(["hello"], "skill.zip", { type: "application/zip" }),
    );
    await press(dialog.getByRole("button", { name: "Add plugin" }));

    await vi.waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(control.calls[0]?.body).toEqual({
      source: {
        type: "archive",
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
      archive: "aGVsbG8=",
    });
  });
});

describe("a person's plugins", () => {
  const mine: UserPlugin[] = [
    {
      ...plugin({
        id: "drive",
        name: "Google Drive",
        enabled: true,
        servers: [
          {
            name: "drive",
            url: "https://drive.example.test/mcp",
            credential: "login-identity",
            personal: true,
          },
        ],
      }),
      userEnabled: true,
      connections: [{ server: "drive", state: "needs_connection" }],
    },
    {
      ...plugin({
        id: "search",
        name: "Search",
        enabled: true,
        servers: [
          {
            name: "search",
            url: "https://search.example.test/mcp",
            credential: "organization",
            personal: false,
          },
        ],
      }),
      userEnabled: false,
      connections: [{ server: "search", state: "needs_configuration" }],
    },
    {
      ...plugin({ id: "sales", name: "Sales", kind: "bundle", enabled: false }),
      userEnabled: true,
      connections: [],
    },
  ];

  it("shows what each plugin needs and saves the person's choice", async () => {
    let enabled = new Set(["drive", "sales"]);
    const control = fakeControl({
      "GET /api/baskule/plugins": () => ({
        plugins: mine.map((entry) => ({ ...entry, userEnabled: enabled.has(entry.id) })),
      }),
      "PUT /api/baskule/plugins/search/enabled": (body) => {
        enabled = new Set([...enabled, "search"]);
        return body;
      },
    });
    using _fetch = control.stub;
    await using screen = await render(<UserPluginsView />);

    await expect
      .element(screen.getByRole("button", { name: "Connect your account" }))
      .toBeVisible();
    await expect.element(screen.getByRole("switch", { name: "Use Sales" })).toBeDisabled();
    await expect.element(screen.getByText("Your admin turned it off for now.")).toBeVisible();
    // The missing organization key only matters once the person turns the plugin on.
    expect(screen.getByText("Waiting for your admin to add its key.").query()).toBeNull();

    await press(screen.getByRole("switch", { name: "Use Search" }));
    await expect.element(screen.getByText("Waiting for your admin to add its key.")).toBeVisible();
    expect(
      control.calls.find((call) => call.route === "PUT /api/baskule/plugins/search/enabled")?.body,
    ).toEqual({
      enabled: true,
    });
  });
});
