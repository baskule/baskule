// baskule: daily tokens or cost, drawn by T3's usage chart. One measure at a time: tokens and money
// have different scales, so they never share an axis.
import { useState } from "react";

import { useTranslation } from "../../i18n";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import {
  UsageProviderChart,
  type UsageChartMetric,
} from "../../components/usage/UsageProviderChart";
import type { UsageDaily } from "./api";
import { CHART_PROVIDERS, chartDays } from "./format";

export function UsageDailyChart({
  title,
  daily,
}: {
  readonly title: string;
  readonly daily: ReadonlyArray<UsageDaily>;
}) {
  const t = useTranslation();
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const days = daily.map((day) => day.date);
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-7 items-center justify-between gap-3 px-3 sm:px-4">
        <h2 className="text-sm font-normal text-foreground/70">{title}</h2>
        <ToggleGroup
          aria-label={t("Chart measure")}
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "cost" || value === "tokens") setMetric(value);
          }}
        >
          <Toggle value="cost">{t("Cost")}</Toggle>
          <Toggle value="tokens">{t("Tokens")}</Toggle>
        </ToggleGroup>
      </div>
      <div className="rounded-xl border border-border/60 bg-card/40 px-2 pt-4 pb-2 shadow-xs/5 sm:px-3">
        <UsageProviderChart
          providers={CHART_PROVIDERS}
          days={days}
          daily={chartDays(daily)}
          hours={[]}
          hourly={[]}
          metric={metric}
          referenceTime={undefined}
          resolution="day"
          timeZone="UTC"
          hour12={false}
        />
      </div>
    </section>
  );
}
