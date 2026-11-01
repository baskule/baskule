import { useLocale, useTranslation } from "../../i18n";
// baskule: Settings → Usage: what the signed-in person used, in every space, and their limits.
import { formatUsd } from "@t3tools/shared/usageFormat";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { useApiResource } from "../ui";
import { PageMessage, PageSection } from "../views/BaskulePage";
import { usageApi, type MyUsage, type UsageAmount, type UsageModel } from "./api";
import { amountColumns, modelColumns } from "./columns";
import { formatTokens } from "./format";
import { UsageDailyChart } from "./UsageDailyChart";
import { UsageLimitBars } from "./UsageLimitBars";
import { UsageTable } from "./UsageTable";

// Reset times read "today" or "tomorrow" against the moment the figures were loaded.
const loadMine = async () => ({ usage: await usageApi.me(), at: Date.now() });

export function MyUsagePage() {
  const t = useTranslation();
  const usage = useApiResource(loadMine);
  return (
    <SettingsPageContainer>
      {usage.data ? (
        <MyUsageView usage={usage.data.usage} now={usage.data.at} />
      ) : (
        <PageMessage>
          {usage.error ? (
            <span className="flex flex-col items-center gap-3">
              {usage.error}
              <Button variant="outline" size="sm" onClick={() => void usage.reload()}>
                {t("Try again")}
              </Button>
            </span>
          ) : (
            <Spinner />
          )}
        </PageMessage>
      )}
    </SettingsPageContainer>
  );
}

/** Tokens and money side by side, money first: it is the figure people compare. */
export function AmountTile({ label, amount }: { label: string; amount: UsageAmount }) {
  const t = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-3 sm:px-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-medium text-foreground tabular-nums">
        {formatUsd(amount.costUsd)}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {t("{{tokens}} tokens", { tokens: formatTokens(amount.tokens) })}
      </span>
    </div>
  );
}

/** Local time of midnight UTC, when the usage day turns; null where that is midnight. */
function dayStart(locale: string, now: number): string | null {
  const today = new Date(now);
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (new Date(midnight).getTimezoneOffset() === 0) return null;
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(midnight);
}

export function MyUsageView({ usage, now }: { usage: MyUsage; now: number }) {
  const t = useTranslation();
  const locale = useLocale();
  const start = dayStart(locale, now);
  return (
    <>
      {usage.limits.length > 0 ? (
        <PageSection
          title={t("Your limits")}
          description={t(
            "Set by your administrator. They count every message you send, in all your spaces.",
          )}
        >
          <UsageLimitBars limits={usage.limits} now={now} />
        </PageSection>
      ) : null}
      <PageSection title={t("Your usage")}>
        <div className="grid grid-cols-3 divide-x divide-border/50">
          <AmountTile label={t("Today")} amount={usage.totals.today} />
          <AmountTile label={t("This week")} amount={usage.totals.week} />
          <AmountTile label={t("This month")} amount={usage.totals.month} />
        </div>
      </PageSection>
      <UsageDailyChart title={t("Last 90 days")} daily={usage.daily} />
      <PageSection title={t("By model, last 90 days")}>
        <UsageTable
          label={t("Usage by model")}
          rows={usage.byModel}
          columns={[...modelColumns<UsageModel>(t), ...amountColumns<UsageModel>(t)]}
          rowKey={(row) => `${row.provider}:${row.model}`}
          bar={(row) => row.tokens}
          emptyText={t("No messages in the last 90 days.")}
        />
      </PageSection>
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        {t(
          "Counts the messages you send in every space. Costs are estimates from the prices your administrator set.",
        )}{" "}
        {start ? t("Days start at {{time}} your time (midnight UTC).", { time: start }) : null}
      </p>
    </>
  );
}
