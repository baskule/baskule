import { render } from "../../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { AdminUsage, UsageLimitSettings } from "../../usage/api";

const api = vi.hoisted(() => ({
  limits: { enabled: false, rules: [] } as UsageLimitSettings,
  saved: [] as UsageLimitSettings[],
}));

vi.mock("../../usage/api", () => ({
  usageApi: {
    limits: async () => api.limits,
    setLimits: async (settings: UsageLimitSettings) => {
      api.saved.push(settings);
      return settings;
    },
    admin: async (): Promise<AdminUsage> => ({
      from: "2026-10-01",
      to: "2026-10-25",
      totals: { tokens: 3_000_000, costUsd: 30, chats: 4, turns: 20, activeUsers: 2 },
      byUser: [
        {
          userId: "u-a",
          name: "Ada",
          email: "ada@x.test",
          tokens: 1_000_000,
          costUsd: 20,
          chats: 1,
          turns: 5,
        },
        {
          userId: "u-b",
          name: "Bob",
          email: "bob@x.test",
          tokens: 2_000_000,
          costUsd: 10,
          chats: 3,
          turns: 15,
        },
      ],
      byModel: [],
      bySpace: [
        { spaceId: "p-1", name: "Personal", tokens: 3_000_000, costUsd: 30, chats: 4, turns: 20 },
      ],
      daily: [{ date: "2026-10-25", tokens: 3_000_000, costUsd: 30, turns: 20 }],
    }),
  },
}));
vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  baskuleApi: {
    adminSpaces: async () => [
      {
        id: "p-1",
        name: "Personal",
        kind: "personal",
        ownerName: "Ada",
        memberCount: 1,
        members: [],
        status: null,
        checkedAt: null,
      },
    ],
  },
}));

const setup = (limits: UsageLimitSettings) => {
  api.limits = limits;
  api.saved = [];
};

const { LimitsEditor } = await import("./LimitsEditor");
const { UsageDashboard } = await import("./UsageDashboard");

describe("limits editor", () => {
  it("turns on a daily token limit for everyone", async () => {
    setup({ enabled: false, rules: [] });
    await using screen = await render(<LimitsEditor />);
    await expect.element(screen.getByText(/^Off: nobody is limited/)).toBeVisible();
    await userEvent.click(screen.getByRole("switch", { name: "Limit usage" }));
    await userEvent.click(screen.getByRole("switch", { name: "Daily limit" }));
    await userEvent.type(screen.getByLabelText("Tokens per person"), "2M");
    await expect.element(screen.getByText("2,000,000 tokens")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await vi.waitFor(() =>
      expect(api.saved).toEqual([
        { enabled: true, rules: [{ window: "daily", tokens: 2_000_000 }] },
      ]),
    );
  });

  it("does not save a limit without an amount", async () => {
    setup({ enabled: true, rules: [{ window: "weekly", costUsd: 10 }] });
    await using screen = await render(<LimitsEditor />);
    await userEvent.click(screen.getByRole("switch", { name: "Daily limit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await expect
      .element(screen.getByText("Daily limit: set a token limit, a cost limit, or both."))
      .toBeVisible();
    expect(api.saved).toEqual([]);
  });
});

describe("usage dashboard", () => {
  it("sorts people by any column and names personal spaces by owner", async () => {
    setup({ enabled: false, rules: [] });
    await using screen = await render(<UsageDashboard />);
    const people = screen.getByRole("table", { name: "Usage per person" });
    const firstPerson = () => people.element().querySelector("tbody tr td")?.textContent;
    await expect.element(people.getByText("Ada")).toBeVisible();
    expect(firstPerson()).toMatch(/^Ada/);
    await userEvent.click(people.getByRole("button", { name: "Tokens" }));
    expect(firstPerson()).toMatch(/^Bob/);
    await userEvent.click(screen.getByRole("button", { name: "Spaces" }));
    await expect.element(screen.getByText("Personal space of Ada")).toBeVisible();
  });
});
