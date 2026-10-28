import { describe, expect, it } from "vite-plus/test";
import { getPreviewPanelDefaultWidth } from "../../hooks/usePreviewPanelInlineSize";

describe("preview panel default width", () => {
  it("uses half of the available workspace on wide screens", () => {
    expect(getPreviewPanelDefaultWidth(3184)).toBe(1592);
    expect(getPreviewPanelDefaultWidth(1744)).toBe(872);
  });

  it("keeps the readable default on smaller screens", () => {
    expect(getPreviewPanelDefaultWidth(1024)).toBe(540);
  });
});
