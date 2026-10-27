import { render } from "../../../test/render";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import type { MyUsage, UsageWindowStatus } from "./api";
import { MyUsageView } from "./MyUsagePage";
import { usageLimitBanner } from "./useUsageComposerBanner";

const now = Date.parse("2026-10-25T10:00:00Z");
const amount = (tokens: number, costUsd: number) => ({ tokens, costUsd });
const daily: UsageWindowStatus = {
  window: "daily",
  used: amount(1_700_000, 2),
  limit: { tokens: 2_000_000 },
  resetsAt: "2026-10-26T00:00:00.000Z",
  blocked: false,
};
const monthly: UsageWindowStatus = {
  window: "monthly",
  used: amount(9_000_000, 50),
  limit: { costUsd: 50 },
  resetsAt: "2026-11-01T00:00:00.000Z",
  blocked: true,
};
const usage = (limits: UsageWindowStatus[]): MyUsage => ({
  limits,
  totals: {
    today: amount(1_700_000, 2),
    week: amount(4_000_000, 20),
    month: amount(9_000_000, 50),
  },
  daily: [
    { date: "2026-10-24", tokens: 0, costUsd: 0, turns: 0 },
    { date: "2026-10-25", tokens: 1_700_000, costUsd: 2, turns: 12 },
  ],
  byModel: [{ provider: "mistral", model: "mistral-large-4", tokens: 9_000_000, costUsd: 50 }],
});

describe("Settings → Usage", () => {
  it("shows each limit as a bar with what is used and when it resets", async () => {
    await using screen = await render(<MyUsageView usage={usage([daily, monthly])} now={now} />);
    const dailyBar = screen.getByRole("meter", { name: "Daily limit" });
    await expect.element(dailyBar).toHaveAttribute("aria-valuenow", "85");
    await expect.element(screen.getByText("85% used")).toBeVisible();
    await expect.element(screen.getByText("1.7M of 2M tokens")).toBeVisible();
    await expect
      .element(screen.getByRole("meter", { name: "Monthly limit" }))
      .toHaveAttribute("aria-valuenow", "100");
    await expect.element(screen.getByText("Reached")).toBeVisible();
    await expect.element(screen.getByText(/^You can send messages again /)).toBeVisible();
    await expect.element(screen.getByText("Mistral Large 4")).toBeVisible();
  });

  it("shows usage without bars when limits are off", async () => {
    await using screen = await render(<MyUsageView usage={usage([])} now={now} />);
    await expect.element(screen.getByText("Your usage")).toBeVisible();
    expect(screen.getByText("Your limits").query()).toBeNull();
    expect(screen.getByRole("meter").query()).toBeNull();
  });
});

describe("composer limit notice", () => {
  const banner = (limits: UsageWindowStatus[], dismissed: string | null = null) =>
    usageLimitBanner({ limits, now, locale: "en", dismissed, onDismiss: () => undefined });

  it("stays silent until a limit is close", () => {
    expect(banner([{ ...daily, used: amount(1_000_000, 0) }])).toBeNull();
    expect(banner([])).toBeNull();
  });

  it("offers a dismissible notice near a limit", () => {
    const item = banner([daily]);
    expect(item).toMatchObject({ variant: "info", title: "Daily limit" });
    expect(String(item?.description)).toMatch(/^85% used · Resets /);
    expect(banner([daily], "daily:2026-10-26T00:00:00.000Z:8")).toBeNull();
  });

  it("names the reached limit and when messages can be sent again", () => {
    const item = banner([daily, monthly]);
    expect(item).toMatchObject({ variant: "warning", title: "Monthly limit reached" });
    expect(String(item?.description)).toMatch(/^You can send messages again /);
    expect(item?.onDismiss).toBeUndefined();
  });
});
