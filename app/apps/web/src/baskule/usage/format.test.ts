import { describe, expect, it } from "vite-plus/test";

import type { UsageWindowStatus } from "./api";
import {
  formatResetTime,
  formatTokens,
  limitAmounts,
  limitRecoveryCopy,
  nearestWindow,
  parseTokens,
  periodRange,
  toCsv,
  windowShare,
} from "./format";

const status = (overrides: Partial<UsageWindowStatus> = {}): UsageWindowStatus => ({
  window: "daily",
  used: { tokens: 500_000, costUsd: 4 },
  limit: { tokens: 1_000_000, costUsd: 5 },
  resetsAt: "2026-10-26T00:00:00.000Z",
  blocked: false,
  ...overrides,
});

describe("windowShare", () => {
  it("follows whichever limit runs out first", () => {
    expect(windowShare(status())).toBe(0.8);
    expect(windowShare(status({ limit: { tokens: 1_000_000 } }))).toBe(0.5);
  });

  it("is full once the server blocks, even below the stored figures", () => {
    expect(windowShare(status({ blocked: true, used: { tokens: 0, costUsd: 0 } }))).toBe(1);
  });
});

it("nearestWindow prefers a blocked window, then the fullest", () => {
  const weekly = status({ window: "weekly", used: { tokens: 900_000, costUsd: 1 } });
  const monthly = status({ window: "monthly", blocked: true, used: { tokens: 1, costUsd: 0 } });
  expect(nearestWindow([status(), weekly])?.window).toBe("weekly");
  expect(nearestWindow([status(), weekly, monthly])?.window).toBe("monthly");
  expect(nearestWindow([])).toBeNull();
});

it("limitAmounts gives tokens and money side by side, only for the limits set", () => {
  expect(limitAmounts(status())).toBe("500K of 1M tokens · $4.00 of $5.00");
  expect(limitAmounts(status({ limit: { costUsd: 5 } }))).toBe("$4.00 of $5.00");
});

describe("formatResetTime", () => {
  const now = new Date(2026, 9, 25, 10, 0).getTime();
  const at = (days: number, hour: number) => new Date(2026, 9, 25 + days, hour, 0);
  const clock = (date: Date) =>
    new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(date);

  it("says today, tomorrow, a weekday, then a date, in local time", () => {
    expect(formatResetTime(at(0, 23).toISOString(), now, "en")).toBe(
      `today at ${clock(at(0, 23))}`,
    );
    expect(formatResetTime(at(1, 1).toISOString(), now, "en")).toBe(
      `tomorrow at ${clock(at(1, 1))}`,
    );
    expect(formatResetTime(at(3, 1).toISOString(), now, "en")).toMatch(/^Wednesday at /);
    expect(formatResetTime(at(7, 1).toISOString(), now, "en")).toMatch(/^November 1 at /);
  });
});

describe("periodRange", () => {
  const now = Date.parse("2026-01-15T22:00:00Z");

  it("counts inclusive UTC days", () => {
    expect(periodRange("7d", now)).toEqual({ from: "2026-01-09", to: "2026-01-15" });
    expect(periodRange("month", now)).toEqual({ from: "2026-01-01", to: "2026-01-15" });
  });

  it("finds last month across a year boundary", () => {
    expect(periodRange("last-month", now)).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});

it("formatTokens abbreviates without trailing zeros", () => {
  expect(formatTokens(1_700_000)).toBe("1.7M");
  expect(formatTokens(2_000_000)).toBe("2M");
  expect(formatTokens(12_400)).toBe("12.4K");
  expect(formatTokens(1_234_567)).toBe("1.23M");
  expect(formatTokens(950)).toBe("950");
});

it("parseTokens reads amounts the way people type them", () => {
  expect(parseTokens("2M")).toBe(2_000_000);
  expect(parseTokens("1.5m")).toBe(1_500_000);
  expect(parseTokens("500 k")).toBe(500_000);
  expect(parseTokens("1,000,000")).toBe(1_000_000);
  expect(parseTokens("1 000 000")).toBe(1_000_000);
  expect(parseTokens("250000")).toBe(250_000);
  expect(parseTokens("1.5")).toBeNull();
  expect(parseTokens("lots")).toBeNull();
  expect(parseTokens("")).toBeNull();
});

it("toCsv quotes only the cells that need it", () => {
  expect(
    toCsv([
      ["Name", "Cost"],
      ['Ada "Admin", Lovelace', 1.5],
    ]),
  ).toBe('Name,Cost\r\n"Ada ""Admin"", Lovelace",1.5');
});

it("limitRecoveryCopy names the limit that refused a message", () => {
  const now = new Date(2026, 9, 25, 10, 0).getTime();
  const resetsAt = new Date(2026, 9, 26, 1, 0).toISOString();
  expect(limitRecoveryCopy({ window: "weekly", resetsAt }, now, "en")).toEqual({
    title: "Weekly limit reached",
    description: expect.stringMatching(/^You can send messages again tomorrow at /),
  });
  expect(limitRecoveryCopy(undefined, now, "en")).toBeUndefined();
});
