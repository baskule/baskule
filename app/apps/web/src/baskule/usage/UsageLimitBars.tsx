// baskule: one bar per limit window, used vs limit. The bar shows whichever limit (tokens or cost)
// runs out first; the text gives both, and the reset in local time.
import { Fragment } from "react";

import { useLocale, useTranslation } from "../../i18n";
import { Badge } from "../../components/ui/badge";
import { cn } from "../../lib/utils";
import type { UsageWindowStatus } from "./api";
import {
  NEAR_LIMIT_SHARE,
  USAGE_COLOR,
  formatShare,
  limitAmounts,
  resetSentence,
  windowCopy,
  windowShare,
} from "./format";

function LimitBar({ status, className }: { status: UsageWindowStatus; className?: string }) {
  const share = windowShare(status);
  // Status colors only once a limit is close; the text says the same in words.
  const fill = status.blocked ? "bg-destructive" : share >= NEAR_LIMIT_SHARE ? "bg-warning" : "";
  return (
    <div
      role="meter"
      aria-label={windowCopy(status.window).name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, Math.round(share * 100))}
      aria-valuetext={`${formatShare(share)} · ${limitAmounts(status)}`}
      className={cn("h-2 overflow-hidden rounded-full bg-muted", className)}
    >
      {share > 0 ? (
        <div
          className={cn("h-full min-w-1 rounded-full", fill)}
          style={{
            width: `${Math.min(100, share * 100)}%`,
            ...(fill ? {} : { backgroundColor: USAGE_COLOR }),
          }}
        />
      ) : null}
    </div>
  );
}

export function UsageLimitBars({
  limits,
  now,
}: {
  readonly limits: ReadonlyArray<UsageWindowStatus>;
  readonly now: number;
}) {
  const t = useTranslation();
  const locale = useLocale();
  return limits.map((status) => {
    const copy = windowCopy(status.window);
    return (
      <div key={status.window} className="flex flex-col gap-2 px-3 py-3.5 sm:px-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-foreground">{copy.name}</span>
          {status.blocked ? (
            <Badge variant="error">{t("Reached")}</Badge>
          ) : (
            <span className="text-sm font-medium text-foreground tabular-nums">
              {t("{{share}} used", { share: formatShare(windowShare(status)) })}
            </span>
          )}
        </div>
        <LimitBar status={status} />
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
          <span>{limitAmounts(status)}</span>
          <span>{resetSentence(status, now, locale)}</span>
        </div>
      </div>
    );
  });
}

/** The composer's version: one line per window, as T3's compact limit windows. */
export function CompactUsageLimitBars({
  limits,
}: {
  readonly limits: ReadonlyArray<UsageWindowStatus>;
}) {
  const t = useTranslation();
  return (
    <div className="grid grid-cols-[minmax(0,8rem)_minmax(3rem,1fr)_auto] items-center gap-x-3 gap-y-1.5">
      {limits.map((status) => (
        <Fragment key={status.window}>
          <span className="truncate text-xs text-muted-foreground">
            {windowCopy(status.window).name}
          </span>
          <LimitBar status={status} />
          <span className="text-xs font-medium whitespace-nowrap text-foreground tabular-nums">
            {status.blocked ? t("Reached") : formatShare(windowShare(status))}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
