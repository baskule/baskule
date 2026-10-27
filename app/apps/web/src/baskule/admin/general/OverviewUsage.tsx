// baskule: General → Overview: this month's usage at a glance, with a link to the dashboard.
import { Link } from "@tanstack/react-router";
import { formatCount, formatUsd } from "@t3tools/shared/usageFormat";
import { ChevronRightIcon } from "lucide-react";

import { useTranslation } from "../../../i18n";
import { Button } from "../../../components/ui/button";
import { Spinner } from "../../../components/ui/spinner";
import { useApiResource } from "../../ui";
import { usageApi } from "../../usage/api";
import { formatTokens, periodRange } from "../../usage/format";
import { PageMessage, PageSection } from "../../views/BaskulePage";

const loadThisMonth = () => usageApi.admin(periodRange("month", Date.now()));

export function OverviewUsage() {
  const t = useTranslation();
  const usage = useApiResource(loadThisMonth);
  const totals = usage.data?.totals;
  return (
    <PageSection
      title={t("Usage this month")}
      action={
        <Button
          variant="ghost"
          size="sm"
          render={<Link to="/admin/$section/$page" params={{ section: "ai", page: "usage" }} />}
        >
          {t("Usage & limits")}
          <ChevronRightIcon />
        </Button>
      }
    >
      {totals ? (
        <div className="grid grid-cols-3 divide-x divide-border/50">
          {[
            { label: t("Cost"), value: formatUsd(totals.costUsd) },
            { label: t("Tokens"), value: formatTokens(totals.tokens) },
            { label: t("Active people"), value: formatCount(totals.activeUsers) },
          ].map((stat) => (
            <div key={stat.label} className="flex min-w-0 flex-col gap-1 px-3 py-2.5 sm:px-4">
              <span className="text-xs text-muted-foreground">{stat.label}</span>
              <span className="text-lg font-medium tabular-nums">{stat.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <PageMessage>{usage.error ?? <Spinner />}</PageMessage>
      )}
    </PageSection>
  );
}
