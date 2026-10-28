// baskule: a panel follows its responsive default width until the person saves a width
// (hooks/useResizableWidth.ts, hooks/usePreviewPanelInlineSize.ts).
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { useResizableWidth } from "../hooks/useResizableWidth";

const STORAGE_KEY = "baskule-test-panel-width";

function storedWidth(value: string | null): Disposable {
  if (value === null) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, value);
  return { [Symbol.dispose]: () => localStorage.removeItem(STORAGE_KEY) };
}

function Panel({ defaultWidth }: { defaultWidth: number }) {
  const { width } = useResizableWidth({
    storageKey: STORAGE_KEY,
    defaultWidth,
    minWidth: 200,
    maxWidth: 800,
    edge: "left",
  });
  return <output>{width}</output>;
}

describe("responsive default width", () => {
  it("follows the default until a width is stored", async () => {
    using _stored = storedWidth(null);
    // No links or navigation in this panel.
    await using screen = await render(<Panel defaultWidth={400} />, { router: false });
    const shownWidth = () => Number(screen.container.querySelector("output")!.textContent);
    expect(shownWidth()).toBe(400);
    await screen.rerender(<Panel defaultWidth={600} />);
    expect(shownWidth()).toBe(600);
  });

  it("keeps a stored width when the default changes", async () => {
    using _stored = storedWidth("650");
    // No links or navigation in this panel.
    await using screen = await render(<Panel defaultWidth={400} />, { router: false });
    const shownWidth = () => Number(screen.container.querySelector("output")!.textContent);
    expect(shownWidth()).toBe(650);
    await screen.rerender(<Panel defaultWidth={700} />);
    expect(shownWidth()).toBe(650);
  });
});
