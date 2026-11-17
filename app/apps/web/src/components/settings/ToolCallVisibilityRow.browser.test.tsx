import { DEFAULT_UNIFIED_SETTINGS, type ToolCallVisibility } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ToolCallVisibilityRow } from "./SettingsPanels";
import { useScopedSettings } from "./useScopedSettings";

const state = vi.hoisted(() => ({
  update: vi.fn(),
}));

vi.mock(import("./useScopedSettings"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useScopedSettings: vi.fn(),
    useUpdateScopedSettings: () => state.update,
  };
});

function setup(visibility = DEFAULT_UNIFIED_SETTINGS.toolCallVisibility) {
  vi.mocked(useScopedSettings).mockReturnValue({
    ...DEFAULT_UNIFIED_SETTINGS,
    toolCallVisibility: visibility,
  });
  state.update.mockClear();
  return {
    [Symbol.dispose]() {
      vi.mocked(useScopedSettings).mockReset();
      state.update.mockReset();
    },
  };
}

it("defaults to Hide all and saves an explicit Show all choice", async () => {
  using _settings = setup();
  await using screen = await render(<ToolCallVisibilityRow />);
  const picker = screen.getByRole("combobox", { name: "Tool calls in chat" });
  await expect.element(picker).toHaveTextContent("Hide all");

  await picker.click();
  await page.getByRole("option", { name: "Show all", exact: true }).click();

  expect(state.update).toHaveBeenCalledExactlyOnceWith({ toolCallVisibility: "showAll" });
});

it.each([
  ["showAll", "Show all"],
  ["hideSuccessful", "Hide successful"],
  ["hideAll", "Hide all"],
  ["zen", "Zen"],
] satisfies Array<[ToolCallVisibility, string]>)(
  "renders the saved %s choice without overwriting it",
  async (visibility, label) => {
    using _settings = setup(visibility);
    await using screen = await render(<ToolCallVisibilityRow />);

    await expect
      .element(screen.getByRole("combobox", { name: "Tool calls in chat" }))
      .toHaveTextContent(label);
    expect(state.update).not.toHaveBeenCalled();
  },
);
