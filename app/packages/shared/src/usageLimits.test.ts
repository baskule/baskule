import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type LimitAccount,
  isUsageLimitsCommand,
  collectProviderUsageLimits,
  withUsageLimitsCommands,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  elapsedShare,
  formatResetsIn,
  limitsNotice,
  paceOf,
  paceRemainingPercent,
  providersWithLimits,
  remainingPercent,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("pace", () => {
  it.each([
    ["2026-09-03T12:01:00.000Z", "resets in 1m"],
    ["2026-09-03T12:00:59.999Z", "Resets momentarily"],
    ["2026-09-03T12:00:00.001Z", "Resets momentarily"],
    ["2026-09-03T12:00:00.000Z", "resets now"],
    ["2026-09-03T11:59:59.999Z", "resets now"],
  ])("formats the reset boundary at %s", (resetsAt, label) => {
    expect(formatResetsIn({ ...window, resetsAt }, now)).toBe(label);
  });

  it("ignores invalid reset timestamps", () => {
    expect(formatResetsIn({ ...window, resetsAt: "invalid" }, now)).toBeNull();
  });

  it("places the clock three fifths through a five-hour window with two hours left", () => {
    expect(elapsedShare(window, now)).toBeCloseTo(0.6);
    expect(paceRemainingPercent(window, now)).toBe(40);
    expect(paceOf(window, now)).toBe("under");
    expect(paceOf({ ...window, usedPercent: 62 }, now)).toBe("on");
    expect(paceOf({ ...window, usedPercent: 80 }, now)).toBe("ahead");
  });

  it("has no pace without a reset or a duration", () => {
    expect(paceOf({ ...window, resetsAt: undefined }, now)).toBeNull();
    expect(paceOf({ ...window, windowDurationMins: undefined }, now)).toBeNull();
    expect(paceRemainingPercent({ ...window, resetsAt: undefined }, now)).toBeNull();
    expect(paceRemainingPercent({ ...window, windowDurationMins: undefined }, now)).toBeNull();
    expect(formatResetsIn({ ...window, resetsAt: undefined }, now)).toBeNull();
  });

  it("keeps pace marks within the bar before a window starts and after it expires", () => {
    expect(paceRemainingPercent(window, Date.parse("2026-09-03T08:00:00.000Z"))).toBe(100);
    expect(paceRemainingPercent(window, Date.parse("2026-09-03T15:00:00.000Z"))).toBe(0);
  });

  it("phrases the reset as a countdown", () => {
    expect(formatResetsIn(window, now)).toBe("resets in 2h 0m");
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-06T15:30:00.000Z" }, now)).toBe(
      "resets in 3d 3h",
    );
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-03T11:00:00.000Z" }, now)).toBe(
      "resets now",
    );
  });
});

describe("limitsNotice", () => {
  it("explains empty bars and passes provider messages through", () => {
    const checkedAt = "2026-09-03T11:00:00.000Z";
    expect(limitsNotice({ checkedAt, windows: [window] })).toBeNull();
    expect(limitsNotice({ checkedAt, windows: [] })).toBe("No limits reported.");
    expect(limitsNotice({ checkedAt, windows: [], unavailable: { reason: "unsupported" } })).toBe(
      "This account has no subscription limits.",
    );
    expect(
      limitsNotice({
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Codex timed out." },
      }),
    ).toBe("Codex timed out.");
  });
});

describe("providersWithLimits", () => {
  it("keeps only usable providers whose driver reports limits at all", () => {
    const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
    const codex = provider({ usageLimits: limits });
    expect(
      providersWithLimits([
        codex,
        provider({
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
        }),
        provider({
          instanceId: ProviderInstanceId.make("off"),
          enabled: false,
          usageLimits: limits,
        }),
        provider({
          instanceId: ProviderInstanceId.make("gone"),
          installed: false,
          usageLimits: limits,
        }),
        provider({
          instanceId: ProviderInstanceId.make("shadow"),
          availability: "unavailable",
          usageLimits: limits,
        }),
      ]),
    ).toEqual([codex]);
  });
});

describe("pools", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const weekly = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
    resetsAt: "2026-09-06T12:00:00.000Z",
  } as const;
  const claude = ProviderDriverKind.make("claudeAgent");
  const laptop = { entry: { target: { label: "Laptop" } } };

  it("merges OpenCode Go limits from machines with the same API key", () => {
    const go = provider({
      driver: ProviderDriverKind.make("opencode"),
      instanceId: ProviderInstanceId.make("opencode"),
      auth: { status: "authenticated" },
      usageLimits: {
        checkedAt,
        credentialFingerprint: "shared-go-key",
        windows: [{ ...window, id: "go_rolling", usedPercent: 3 }],
      },
    });
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [go] } }],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: {
            providers: [
              {
                ...go,
                usageLimits: {
                  ...go.usageLimits!,
                  checkedAt: "2026-09-03T11:30:00.000Z",
                  windows: [{ ...window, id: "go_rolling", usedPercent: 4 }],
                },
              },
            ],
          },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.environments).toEqual([
      { environmentId: "env-a", label: "Laptop" },
      { environmentId: "env-b", label: "Desktop" },
    ]);
    expect(collectLimitPools(accounts, now)[0]?.windows[0]?.members).toHaveLength(1);
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(4);

    const differentKey = {
      ...go,
      usageLimits: { ...go.usageLimits!, credentialFingerprint: "other-go-key" },
    };
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: { providers: [differentKey] },
    });
    expect(collectLimitAccounts(input)).toHaveLength(2);

    input.set(EnvironmentId.make("env-a"), {
      ...laptop,
      serverConfig: {
        providers: [{ ...go, auth: { status: "authenticated", email: "same@example.com" } }],
      },
    });
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: {
        providers: [
          { ...differentKey, auth: { status: "authenticated", email: "SAME@example.com" } },
        ],
      },
    });
    expect(collectLimitAccounts(input)).toHaveLength(1);
  });

  it("redeems on the environment whose snapshot supplied the credits on show", () => {
    const stale = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt,
        windows: [window],
        resetCredits: { availableCount: 0 },
      },
    });
    const fresh = {
      ...stale,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 2 },
      },
    };
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [stale] } }],
      [
        EnvironmentId.make("env-b"),
        { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [fresh] } },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({ environmentId: "env-b", input: { instanceId: "codex" } });
  });

  it("does not give old credits the timestamp of a newer window-only read", () => {
    const snapshots = [
      { checkedAt, windows: [window], resetCredits: { availableCount: 2 } },
      { checkedAt: "2026-09-03T12:00:00.000Z", windows: [window] },
      {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 1 },
      },
    ];
    const input = new Map(
      snapshots.map((usageLimits, i) => [
        EnvironmentId.make(`env-${i}`),
        {
          ...laptop,
          serverConfig: {
            providers: [
              provider({
                auth: { status: "authenticated", email: "same@example.com" },
                usageLimits,
              }),
            ],
          },
        },
      ]),
    );
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.checkedAt).toBe("2026-09-03T12:00:00.000Z");
    expect(account?.limits.resetCredits?.availableCount).toBe(1);
    expect(account?.redeem?.environmentId).toBe("env-2");
  });

  it("names an environment once however many of its instances share the account", () => {
    const shared = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [shared, { ...shared, instanceId: ProviderInstanceId.make("work") }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(input)[0]?.environments).toEqual([
      { environmentId: "env-a", label: "Laptop" },
    ]);
  });
});

describe("pooled account columns", () => {
  const weekly = {
    ...window,
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
  } as const;
  const account = (key: string, windows: LimitAccount["limits"]["windows"]): LimitAccount => ({
    key,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: key,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    redeem: null,
    limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
  });
  const keys = (pool: ReturnType<typeof collectLimitPools>[number]) =>
    pool.windows.map((row) =>
      row.columns.map((member) => (member.window ? member.account.key : null)),
    );

  it("keeps session columns across rows with opposite reset and usage orders", () => {
    const accounts = [
      account("a", [
        { ...weekly, usedPercent: 80, resetsAt: "2026-09-05T12:00:00.000Z" },
        { ...window, usedPercent: 10, resetsAt: "2026-09-03T15:00:00.000Z" },
      ]),
      account("b", [
        { ...weekly, usedPercent: 20, resetsAt: "2026-09-06T12:00:00.000Z" },
        { ...window, usedPercent: 90, resetsAt: "2026-09-03T13:00:00.000Z" },
      ]),
    ];
    const [pool] = collectLimitPools(accounts, now);
    expect(pool!.accounts.map((account) => account.key)).toEqual(["b", "a"]);
    expect(keys(pool!)).toEqual([
      ["b", "a"],
      ["b", "a"],
    ]);
    expect(pool!.windows[1]!.resets.map((reset) => reset.member.account.key)).toEqual(["a", "b"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(50);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual(keys(pool!));
  });

  it("preserves gaps without counting missing windows toward pooled quota", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [window]),
        account("b", [
          { ...window, resetsAt: "2026-09-03T15:00:00.000Z" },
          { ...weekly, usedPercent: 80 },
        ]),
        account("c", [weekly]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([
      ["a", "b", null],
      [null, "b", "c"],
    ]);
    expect(pool!.windows[1]!.members.map((member) => member.account.key)).toEqual(["b", "c"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(40);
    expect(pool!.windows[1]!.resets.map((reset) => reset.restoresPercent)).toEqual([40, 20]);
  });

  it("falls back to weekly resets when no account reports a session", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [{ ...weekly, resetsAt: "2026-09-06T12:00:00.000Z" }]),
        account("b", [{ ...weekly, resetsAt: "2026-09-05T12:00:00.000Z" }]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([["b", "a"]]);
  });

  it("sorts unknown resets last and breaks ties consistently", () => {
    const accounts = [
      account("z", [{ ...window, resetsAt: undefined }]),
      account("b", [window]),
      account("a", [window]),
      account("y", [{ ...window, resetsAt: "invalid" }]),
    ];
    expect(keys(collectLimitPools(accounts, now)[0]!)).toEqual([["a", "b", "y", "z"]]);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual([["a", "b", "y", "z"]]);
  });
});

describe("collectLimitNotices", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const claude = ProviderDriverKind.make("claudeAgent");
  const laptop = { entry: { target: { label: "Laptop" } } };

  it("names failures and silence, skips unsupported accounts, and labels environments only when several", () => {
    const failed = provider({
      instanceId: ProviderInstanceId.make("claude"),
      driver: claude,
      displayName: "Claude Max",
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
    });
    const apiKey = provider({
      instanceId: ProviderInstanceId.make("api"),
      driver: claude,
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
    });
    const silent = provider({ usageLimits: { checkedAt, windows: [] } });
    const one = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [failed, apiKey, silent],
          },
        },
      ],
    ]);
    expect(collectLimitNotices(one)).toEqual([
      "Claude Max: Could not read limits.",
      "codex: No limits reported.",
    ]);

    one.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: { providers: [] },
    });
    expect(collectLimitNotices(one)[0]).toBe("Laptop · Claude Max: Could not read limits.");
  });
});

describe("/usage-limits", () => {
  const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
  const selected = provider({
    usageLimits: limits,
    auth: { status: "authenticated", email: "same@example.com" },
  });

  it("keeps unidentified custom instances separate, filtering by driver", () => {
    const report = collectProviderUsageLimits(
      selected.instanceId,
      [
        selected,
        provider({
          instanceId: ProviderInstanceId.make("codex-work"),
          displayName: "Work",
          usageLimits: { ...limits, resetCredits: { availableCount: 2 } },
        }),
        provider({
          driver: ProviderDriverKind.make("claude"),
          instanceId: ProviderInstanceId.make("claude"),
          usageLimits: limits,
        }),
      ],
      now,
    );
    expect(report?.createdAt).toBe("2026-09-03T12:00:00.000Z");
    expect(report?.accounts.map((account) => account.id)).toEqual(["codex", "codex-work"]);
    expect(report?.accounts[0]).toMatchObject({
      instanceId: selected.instanceId,
      email: selected.auth.email,
    });
    expect(report?.accounts[1]).toMatchObject({
      displayName: "Work",
      limits: { resetCredits: { availableCount: 2 } },
    });
    expect(report?.notices).toEqual([]);
  });

  it("keeps the freshest usable native duplicate and the freshest native credits in either order", () => {
    const failed = provider({
      auth: selected.auth,
      usageLimits: {
        ...limits,
        checkedAt: "2026-09-03T11:40:00.000Z",
        unavailable: { reason: "probeFailed" },
      },
    });
    const credited = provider({
      instanceId: ProviderInstanceId.make("codex-credit"),
      auth: selected.auth,
      usageLimits: {
        checkedAt: "2026-09-03T11:20:00.000Z",
        windows: [{ ...window, usedPercent: 50 }],
        resetCredits: { availableCount: 2 },
      },
    });
    const staleCredit = provider({
      ...credited,
      instanceId: ProviderInstanceId.make("codex-stale-credit"),
      usageLimits: { ...limits, resetCredits: { availableCount: 3 } },
    });
    const freshest = provider({
      instanceId: ProviderInstanceId.make("codex-fresh"),
      auth: selected.auth,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [{ ...window, usedPercent: 55 }],
      },
    });
    const duplicates = [failed, staleCredit, credited, freshest];
    for (const providers of [duplicates, duplicates.toReversed()]) {
      const report = collectProviderUsageLimits(failed.instanceId, providers, now);
      expect(report?.accounts.map((account) => account.id)).toEqual(["codex-fresh"]);
      expect(report?.accounts[0]).toMatchObject({
        limits: {
          checkedAt: "2026-09-03T11:30:00.000Z",
          windows: [{ usedPercent: 55 }],
          resetCredits: { availableCount: 2 },
        },
        resetCreditInput: { instanceId: "codex-credit" },
      });
      expect(report?.accounts[0]?.limits.unavailable).toBeUndefined();
    }
  });

  it("merges native workspace duplicates only while the workspace evidence is unambiguous", () => {
    const known = provider({
      ...selected,
      instanceId: ProviderInstanceId.make("workspace-a"),
      auth: { ...selected.auth, workspaceId: "ws-a" },
    });
    const fresh = provider({
      ...known,
      instanceId: ProviderInstanceId.make("workspace-a-fresh"),
      usageLimits: { ...limits, checkedAt: "2026-09-03T11:30:00.000Z" },
    });
    const natives = [known, fresh, selected];
    expect(
      collectProviderUsageLimits(selected.instanceId, natives, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["workspace-a-fresh"]);

    const unreadable = provider({
      instanceId: ProviderInstanceId.make("workspace-b"),
      auth: { ...selected.auth, workspaceId: "ws-b" },
    });
    expect(
      collectProviderUsageLimits(selected.instanceId, [...natives, unreadable], now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["workspace-a-fresh", "codex"]);
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [...natives, { ...unreadable, usageLimits: limits }],
        now,
      )?.accounts.map((account) => account.id),
    ).toEqual(["workspace-a-fresh", "codex", "workspace-b"]);
  });

  it("advertises global and workspace commands only for providers present in Limits", () => {
    const workspaceSnapshots = [
      { cwd: "/tmp/project", checkedAt: limits.checkedAt, slashCommands: [], skills: [] },
    ];
    const [supported] = withUsageLimitsCommands([provider({ ...selected, workspaceSnapshots })]);
    expect(supported?.slashCommands.map((command) => command.name)).toEqual(["usage-limits"]);
    expect(
      supported?.workspaceSnapshots?.[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
    expect(withUsageLimitsCommands([provider({ workspaceSnapshots })])[0]?.slashCommands).toEqual(
      [],
    );
    const ownCommand = provider({
      ...selected,
      slashCommands: [{ name: "usage-limits", description: "Provider's own" }],
    });
    expect(withUsageLimitsCommands([ownCommand])[0]?.slashCommands).toEqual([
      { name: "usage-limits", description: "Show this provider's usage limits" },
    ]);
  });
});

describe("remainingPercent", () => {
  it("inverts and clamps the reported usage", () => {
    expect(remainingPercent(window)).toBe(60);
    expect(remainingPercent({ ...window, usedPercent: 0 })).toBe(100);
    expect(remainingPercent({ ...window, usedPercent: 100 })).toBe(0);
    expect(remainingPercent({ ...window, usedPercent: 33.4 })).toBe(67);
  });
});

describe("isUsageLimitsCommand", () => {
  it("recognizes only the standalone local action", () => {
    expect(isUsageLimitsCommand("  /USAGE-LIMITS\n")).toBe(true);
    expect(isUsageLimitsCommand("/usage-limits explain")).toBe(false);
    expect(isUsageLimitsCommand("Explain /usage-limits")).toBe(false);
    expect(isUsageLimitsCommand("/usage")).toBe(false);
  });
});

describe("external usage settings", () => {
  it("deduplicates destinations across accounts and environments without inventing quota pools", () => {
    const managed = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
        externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("a"),
        {
          entry: { target: { label: "A" } },
          serverConfig: {
            providers: [managed, { ...managed, instanceId: ProviderInstanceId.make("personal") }],
          },
        },
      ],
      [
        EnvironmentId.make("b"),
        { entry: { target: { label: "B" } }, serverConfig: { providers: [managed] } },
      ],
    ]);
    expect(collectExternalUsageLinks(presentations)).toEqual([
      {
        ...managed.usageLimits!.externalUsage,
        message: "Track usage in ChatGPT.",
        accounts: [`${managed.instanceId} on A`, "personal on A", `${managed.instanceId} on B`],
      },
    ]);
    expect(collectLimitAccounts(presentations)).toEqual([]);
    expect(collectLimitNotices(presentations)).toEqual([]);
  });
  it("omits disabled, uninstalled and signed-out providers", () => {
    const managed = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("a"),
        {
          entry: { target: { label: "A" } },
          serverConfig: {
            providers: [
              { ...managed, enabled: false },
              { ...managed, installed: false },
              { ...managed, auth: { status: "unauthenticated" as const } },
              provider({}),
            ],
          },
        },
      ],
    ]);
    expect(collectExternalUsageLinks(presentations)).toEqual([]);
  });
});
