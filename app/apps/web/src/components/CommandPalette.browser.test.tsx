import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { dispatchCommandPalette, useCommandPaletteStore } from "../commandPaletteStore";
import { LAST_USED_PROJECT_STORAGE_KEY } from "../hooks/useHandleNewThread";
import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { CommandPalette } from "./CommandPalette";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
  activeThread: undefined as Thread | undefined,
  delegatedUnderParent: new Set<string>() as ReadonlySet<string>,
  handleNewThread: vi.fn(async () => undefined),
}));
vi.mock("../state/server", async (original) => {
  const actual = await original<typeof import("../state/server")>();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const { THREAD_JUMP_KEYBINDING_COMMANDS } = await import("@t3tools/contracts");
  // The default jump bindings are desktop-only; these hold in the browser too.
  const jumpBindings = compileResolvedKeybindingsConfig(
    THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
      key: `mod+${index + 1}`,
      command,
    })),
  );
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(jumpBindings) };
});
vi.mock("../hooks/useHandleNewThread", async (original) => {
  const actual = await original<typeof import("../hooks/useHandleNewThread")>();
  return {
    ...actual,
    useHandleNewThread: () => ({
      ...actual.useHandleNewThread(),
      activeThread: entities.activeThread,
      handleNewThread: entities.handleNewThread,
    }),
  };
});
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => entities.projects,
  useVisibleThreadShells: () => entities.threads,
}));

function setup(state: Partial<typeof entities> = {}) {
  // Earlier browser test files share this origin's localStorage; a remembered project
  // that is not listed here hides the default "New thread in <project>" row.
  removeLocalStorageItem(LAST_USED_PROJECT_STORAGE_KEY);
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = state.projects ?? [];
  entities.threads = state.threads ?? [];
  entities.activeThread = state.activeThread;
  entities.delegatedUnderParent = state.delegatedUnderParent ?? new Set();
  entities.handleNewThread.mockClear();
}

function makeProject(title: string): Project {
  return {
    id: ProjectId.make(title),
    environmentId: EnvironmentId.make("local"),
    title,
    workspaceRoot: `/work/${title}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("CommandPalette open intents", () => {
  it("drags a searched thread into the current composer without navigating", async () => {
    const environmentId = EnvironmentId.make("remote");
    const threadId = ThreadId.make("dragged-thread");
    setup({
      threads: [makeThreadFixture({ environmentId, id: threadId, title: "Drag this thread" })],
    });
    const onDrop = vi.fn();
    await using screen = await render(
      <CommandPalette>
        <div
          data-thread-context-drop="true"
          ref={(node) => {
            node?.addEventListener("t3-thread-context-drop", onDrop);
          }}
          style={{ position: "fixed", bottom: 0, width: 300, height: 100 }}
        >
          Composer
        </div>
      </CommandPalette>,
    );
    const pathname = screen.router?.state.location.pathname;
    openCommandPalette();
    await page.getByRole("combobox").fill("Drag this thread");
    const row = page.getByRole("option", { name: /Drag this thread/ });
    await expect.element(row).toBeVisible();
    const bounds = row.element().getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    await act(() => {
      row.element().dispatchEvent(pointer("pointerdown", bounds.x + 20, bounds.y + 10));
      document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 20));
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    await act(() => {
      document.dispatchEvent(pointer("pointermove", 50, window.innerHeight - 30));
      document.dispatchEvent(pointer("pointerup", 50, window.innerHeight - 30));
    });
    expect(onDrop).toHaveBeenCalledOnce();
    expect((onDrop.mock.calls[0]![0] as CustomEvent).detail).toEqual([
      { environmentId, threadId, title: "Drag this thread" },
    ]);
    expect(screen.router?.state.location.pathname).toBe(pathname);
  });

  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
  });

  it("keeps focus while entering a search query", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette();

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await input.fill("acme");
    await expect.element(input).toHaveValue("acme");
  });

  it("opens a searched project's latest listed thread, not a newer subagent or parked thread", async () => {
    const environmentId = EnvironmentId.make("local");
    const projectId = ProjectId.make("acme");
    const parentId = ThreadId.make("parent");
    setup({
      projects: [
        {
          id: projectId,
          environmentId,
          title: "Acme",
          workspaceRoot: "/work/acme",
          repositoryIdentity: null,
          defaultModelSelection: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          scripts: [],
        },
      ],
      threads: [
        makeThreadFixture({
          id: parentId,
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThreadFixture({
          id: ThreadId.make("subagent"),
          environmentId,
          projectId,
          updatedAt: "2026-03-03T00:00:00.000Z",
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        }),
        makeThreadFixture({
          id: ThreadId.make("settled"),
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-05T00:00:00.000Z",
          settledOverride: "settled",
        }),
        makeThreadFixture({
          id: ThreadId.make("snoozed"),
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-06T00:00:00.000Z",
          snoozedUntil: "2999-01-01T00:00:00.000Z",
        }),
      ],
    });
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette();
    await page.getByRole("combobox").fill("Acme");
    await page.getByRole("option", { name: /Acme/ }).first().click();

    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/local/parent"));
  });

  it("starts a thread in an open copy when the current project's copy is archived", async () => {
    const repositoryIdentity = {
      canonicalKey: "github.com/example/acme",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/acme.git",
      },
    };
    const archived = {
      ...makeProject("acme"),
      repositoryIdentity,
      archivedAt: "2026-03-02T00:00:00.000Z",
    };
    const open = {
      ...makeProject("acme"),
      environmentId: EnvironmentId.make("remote"),
      repositoryIdentity,
    };
    setup({
      projects: [archived, open],
      activeThread: makeThreadFixture({
        environmentId: archived.environmentId,
        projectId: archived.id,
      }),
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    await page.getByRole("option", { name: /acme/i }).click();

    await vi.waitFor(() =>
      expect(entities.handleNewThread).toHaveBeenCalledWith({
        environmentId: open.environmentId,
        projectId: open.id,
      }),
    );
  });

  it("numbers filtered New thread in... rows from 1 and jumps to them", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    setup({ projects: [makeProject("server"), makeProject("lima")] });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    await userEvent.fill(page.getByPlaceholder("Search..."), "li");
    await expect.element(page.getByRole("option", { name: /server/ })).not.toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: /lima/ })).toMatchTextContent("Ctrl+1");
    await userEvent.keyboard("{Control>}1{/Control}");

    await vi.waitFor(() =>
      expect(entities.handleNewThread).toHaveBeenCalledWith({
        environmentId: EnvironmentId.make("local"),
        projectId: ProjectId.make("lima"),
      }),
    );
  });

  it("leaves a submenu only on a fresh, unmodified Backspace", async () => {
    setup({ projects: [makeProject("Acme"), makeProject("Beta")] });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    const rootInput = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(rootInput).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("option", { name: /^New thread in\.\.\./ }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Enter}");

    const submenuInput = page.getByPlaceholder("Search...");
    await expect.element(submenuInput).toHaveFocus();

    for (const init of [
      { repeat: true },
      { ctrlKey: true },
      { isComposing: true },
    ] satisfies ReadonlyArray<KeyboardEventInit>) {
      const event = new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      await act(() => submenuInput.element().dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      await expect.element(submenuInput).toBeVisible();
    }

    await userEvent.keyboard("{Backspace}");
    await expect.element(rootInput).toHaveFocus();
  });

  it("ignores repeated Escape keydowns after stepping back from file search", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    const palette = page.getByTestId("command-palette");
    await expect.element(palette).toHaveAttribute("data-palette-mode", "command");

    await act(() => {
      dispatchCommandPalette({
        _tag: "OpenChildSearch",
        mode: "files",
        context: { query: "" },
      });
    });
    await expect.element(palette).toHaveAttribute("data-palette-mode", "files");

    await userEvent.keyboard("{Escape}");
    await expect.element(palette).toHaveAttribute("data-palette-mode", "command");
    await expect
      .element(page.getByPlaceholder("Search commands, projects, and threads..."))
      .toHaveFocus();

    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(useCommandPaletteStore.getState().open).toBe(true);
    await expect.element(palette).toHaveAttribute("data-palette-mode", "command");

    await userEvent.keyboard("{Escape}");
    await expect.element(palette).not.toBeInTheDocument();
  });
});
