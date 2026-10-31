import { describe, expect, it } from "vite-plus/test";
import {
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";
const usage = THREAD_DETAILS_ITEMS.find((item) => item.id === "usage")!;

describe("thread details items", () => {
  it.each([
    { items: {}, usage: false },
    { items: { usage: false }, usage: false },
    { items: { usage: true }, usage: true },
  ])("resolves Usage from overrides: %o", (row) => {
    expect(resolveThreadDetailsVisibility({ threadDetailsItems: row.items }).usage).toBe(row.usage);
  });
  it("stores only choices that differ from the default", () => {
    expect(setThreadDetailsItem({ threadDetailsItems: {} }, usage, true)).toEqual({ usage: true });
    expect(setThreadDetailsItem({ threadDetailsItems: { usage: true } }, usage, false)).toEqual({});
  });
});
