import { describe, expect, it } from "vite-plus/test";

import { t } from "../../../i18n";
import { sortRows, usageCsv, type UsageColumn } from "../../usage/UsageTable";
import { draftOf, settingsOf } from "./LimitsEditor";
import { costOf, priceDraftOf } from "./ModelPrices";

describe("limits form", () => {
  it("round-trips saved rules without rounding them", () => {
    const draft = draftOf({
      enabled: true,
      rules: [
        { window: "daily", tokens: 2_000_000 },
        { window: "monthly", tokens: 2_345_678, costUsd: 40 },
      ],
    });
    expect(draft.windows.daily).toEqual({ on: true, tokens: "2M", cost: "" });
    expect(draft.windows.weekly.on).toBe(false);
    expect(draft.windows.monthly.tokens).toBe("2345678");
    expect(settingsOf(draft, t)).toEqual({
      settings: {
        enabled: true,
        rules: [
          { window: "daily", tokens: 2_000_000 },
          { window: "monthly", tokens: 2_345_678, costUsd: 40 },
        ],
      },
    });
  });

  it("keeps prepared rules while limits are off", () => {
    const draft = draftOf({ enabled: false, rules: [{ window: "weekly", costUsd: 12.5 }] });
    expect(settingsOf(draft, t)).toEqual({
      settings: { enabled: false, rules: [{ window: "weekly", costUsd: 12.5 }] },
    });
  });

  it("explains what is missing instead of saving a limit that cannot apply", () => {
    const empty = draftOf({ enabled: true, rules: [] });
    expect(settingsOf(empty, t)).toEqual({
      error: "Turn on at least one limit below, or turn off Limit usage.",
    });
    const blank = {
      ...empty,
      windows: { ...empty.windows, daily: { on: true, tokens: "", cost: "" } },
    };
    expect(settingsOf(blank, t)).toEqual({
      error: "Daily limit: set a token limit, a cost limit, or both.",
    });
    const typo = {
      ...empty,
      windows: { ...empty.windows, daily: { on: true, tokens: "2 mil", cost: "" } },
    };
    expect("error" in settingsOf(typo, t)).toBe(true);
  });
});

describe("model prices", () => {
  it("saves no cost when every price is empty, and both main prices otherwise", () => {
    expect(costOf(priceDraftOf(undefined))).toBeUndefined();
    expect(costOf({ input: "2", output: "10", cacheRead: "0,1", cacheWrite: "" })).toEqual({
      input: 2,
      output: 10,
      cache_read: 0.1,
    });
  });

  it("refuses half a price list", () => {
    expect(costOf({ input: "2", output: "", cacheRead: "", cacheWrite: "" })).toBeNull();
    expect(costOf({ input: "", output: "", cacheRead: "0.1", cacheWrite: "" })).toBeNull();
    expect(costOf({ input: "-1", output: "2", cacheRead: "", cacheWrite: "" })).toBeNull();
  });
});

describe("usage tables", () => {
  type Row = { name: string; email: string; costUsd: number };
  const columns: UsageColumn<Row>[] = [
    { id: "name", label: "Person", value: (row) => row.name },
    { id: "email", label: "Email", csvOnly: true, value: (row) => row.email },
    {
      id: "cost",
      label: "Cost",
      csvLabel: "Cost (USD)",
      numeric: true,
      value: (row) => row.costUsd,
      csv: (row) => row.costUsd.toFixed(4),
    },
  ];
  const rows: Row[] = [
    { name: "bob", email: "b@x", costUsd: 1 },
    { name: "Ada", email: "a@x", costUsd: 3 },
  ];

  it("sorts figures and names", () => {
    expect(
      sortRows(rows, columns, { column: "cost", descending: true }).map((r) => r.name),
    ).toEqual(["Ada", "bob"]);
    expect(
      sortRows(rows, columns, { column: "name", descending: false }).map((r) => r.name),
    ).toEqual(["Ada", "bob"]);
  });

  it("exports the rows in their order, with CSV-only columns", () => {
    expect(usageCsv(rows, columns)).toBe(
      "Person,Email,Cost (USD)\r\nbob,b@x,1.0000\r\nAda,a@x,3.0000",
    );
  });
});
