import { t } from "../../i18n";

import type { UsageProviderKind } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { UsageMetric } from "./usageShortcuts";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind;
};

export const PROVIDER_PRESENTATION = {
  opencode: {
    get label() {
      return t("OpenCode");
    },
    color: "#5b9bbd",
    driverKind: ProviderDriverKind.make("opencode"),
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}

export function rankProvidersByMetric<Provider extends string>(
  providers: readonly Provider[],
  totals: readonly {
    readonly provider: Provider;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
  metric: UsageMetric,
): readonly Provider[] {
  const field = metric === "cost" ? "costUsd" : "totalTokens";
  const value = (provider: Provider) =>
    totals.find((entry) => entry.provider === provider)?.[field] ?? 0;
  return providers.toSorted((left, right) => value(right) - value(left));
}
