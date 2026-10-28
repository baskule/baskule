// baskule: chat timestamp tooltips follow the UI language (the upstream suite for
// timestampFormat.ts was deleted in T3 Code v0.1.3).
import { describe, expect, it } from "vite-plus/test";

import { formatChatTimestampTooltip } from "../timestampFormat";

describe("formatChatTimestampTooltip", () => {
  it.each([
    ["en", "June 4, 2026"],
    ["fr", "4 juin 2026"],
    ["es", "4 de junio de 2026"],
    ["de", "4. Juni 2026"],
    ["nl", "4 juni 2026"],
    ["it", "4 giugno 2026"],
  ] as const)("uses %s month names and date order", (locale, label) => {
    const date = new Date(2026, 5, 4, 14, 4).toISOString();
    expect(formatChatTimestampTooltip(date, "24-hour", locale)).toBe(`14:04, ${label}`);
  });
});
