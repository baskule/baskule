// baskule: plain-language figures for usage and limits, shared by the user page, the composer
// and the admin dashboard.
import { BASKULE_AI_PROVIDERS, type BaskuleAIProviderId } from "@t3tools/contracts/baskule";
import type { UsageProviderKind } from "@t3tools/contracts";
import { formatTokens as formatTokensFixed, formatUsd } from "@t3tools/shared/usageFormat";
import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { getLocale } from "@t3tools/shared/localization";

import { t } from "../../i18n";
import { PROVIDER_PRESENTATION } from "../../components/usage/usageProviders";
import type { UsageDaily, UsageWindow, UsageWindowStatus } from "./api";

/** T3's abbreviation without trailing zeros: "1.7M", not "1.70M". */
export function formatTokens(value: number): string {
  return formatTokensFixed(value).replace(/\.(\d*?)0+(?=[KMBT]$)/, (_, digits: string) =>
    digits ? `.${digits}` : "",
  );
}

/** At this share of a limit the composer starts showing the bar. */
export const NEAR_LIMIT_SHARE = 0.8;

export const WINDOWS: ReadonlyArray<UsageWindow> = ["daily", "weekly", "monthly"];

// Whole sentences per window, so each language can phrase them its own way.
export const windowCopy = (window: UsageWindow) =>
  ({
    daily: {
      name: t("Daily limit"),
      reached: t("Daily limit reached"),
      period: t("Every day"),
    },
    weekly: {
      name: t("Weekly limit"),
      reached: t("Weekly limit reached"),
      period: t("Every week, from Monday"),
    },
    monthly: {
      name: t("Monthly limit"),
      reached: t("Monthly limit reached"),
      period: t("Every month, from the 1st"),
    },
  })[window];

/** The share of the limit that runs out first: tokens and cost each block on their own. */
export function windowShare(status: UsageWindowStatus): number {
  const shares = [
    status.limit.tokens === undefined
      ? null
      : status.limit.tokens === 0
        ? 1
        : status.used.tokens / status.limit.tokens,
    status.limit.costUsd === undefined
      ? null
      : status.limit.costUsd === 0
        ? 1
        : status.used.costUsd / status.limit.costUsd,
  ].filter((share): share is number => share !== null);
  return status.blocked ? Math.max(1, ...shares) : Math.max(0, ...shares);
}

/** The window closest to blocking the next message, if any. */
export function nearestWindow(limits: ReadonlyArray<UsageWindowStatus>): UsageWindowStatus | null {
  let nearest: UsageWindowStatus | null = null;
  for (const status of limits) {
    if (nearest === null) nearest = status;
    else if (status.blocked !== nearest.blocked) nearest = status.blocked ? status : nearest;
    else if (windowShare(status) > windowShare(nearest)) nearest = status;
  }
  return nearest;
}

export function formatShare(share: number): string {
  // Floor, so 99.6% never reads as a full 100% that has not blocked yet.
  return `${Math.min(100, Math.floor(share * 100))}%`;
}

/** "1.6M of 2M tokens · $4.10 of $5.00": only the limits that are set. */
export function limitAmounts(status: UsageWindowStatus): string {
  const parts: string[] = [];
  if (status.limit.tokens !== undefined)
    parts.push(
      t("{{used}} of {{limit}} tokens", {
        used: formatTokens(status.used.tokens),
        limit: formatTokens(status.limit.tokens),
      }),
    );
  if (status.limit.costUsd !== undefined)
    parts.push(
      t("{{used}} of {{limit}}", {
        used: formatUsd(status.used.costUsd),
        limit: formatUsd(status.limit.costUsd),
      }),
    );
  return parts.join(" · ");
}

const localDay = (time: number) => {
  const date = new Date(time);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
};

/** "today at 01:00", "tomorrow at 01:00", "Monday at 01:00", "1 November at 01:00": local time. */
export function formatResetTime(iso: string, now: number, locale?: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const clock = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    time,
  );
  const days = localDay(time) - localDay(now);
  if (days <= 0) return t("today at {{time}}", { time: clock });
  if (days === 1) return t("tomorrow at {{time}}", { time: clock });
  const day =
    days < 7
      ? new Intl.DateTimeFormat(locale, { weekday: "long" }).format(time)
      : new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" }).format(time);
  return t("{{day}} at {{time}}", { day, time: clock });
}

/** "Resets today at 01:00." or, once blocked, when messages can be sent again. */
export function resetSentence(
  status: Pick<UsageWindowStatus, "resetsAt" | "blocked">,
  now: number,
  locale?: string,
): string {
  const when = formatResetTime(status.resetsAt, now, locale);
  return status.blocked
    ? t("You can send messages again {{when}}.", { when })
    : t("Resets {{when}}.", { when });
}

const CHART_PROVIDER: UsageProviderKind = "opencode";

/** T3's usage chart reads per-provider day totals; Baskule has one series. */
export function chartDays(daily: ReadonlyArray<UsageDaily>): readonly DailyTotals[] {
  return daily.map((day) => ({
    day: day.date,
    costUsd: day.costUsd,
    totalTokens: day.tokens,
    byProvider: new Map([[CHART_PROVIDER, { costUsd: day.costUsd, totalTokens: day.tokens }]]),
  }));
}

export const CHART_PROVIDERS: readonly UsageProviderKind[] = [CHART_PROVIDER];

/** The chart's series color, for every usage bar that is not a warning. */
export const USAGE_COLOR = PROVIDER_PRESENTATION[CHART_PROVIDER].color;

export function modelLabel(provider: string, model: string): { name: string; vendor: string } {
  const preset = BASKULE_AI_PROVIDERS[provider as BaskuleAIProviderId] as
    | (typeof BASKULE_AI_PROVIDERS)[BaskuleAIProviderId]
    | undefined;
  return {
    name: preset?.models.find((entry) => entry.id === model)?.name ?? model,
    vendor: preset?.name ?? provider,
  };
}

export type UsagePeriod = "7d" | "30d" | "90d" | "month" | "last-month";

const utcDate = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Inclusive UTC dates, as the usage API counts them. */
export function periodRange(period: UsagePeriod, now: number): { from: string; to: string } {
  const today = new Date(now);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const day = Date.UTC(year, month, today.getUTCDate());
  switch (period) {
    case "month":
      return { from: utcDate(Date.UTC(year, month, 1)), to: utcDate(day) };
    case "last-month":
      return {
        from: utcDate(Date.UTC(year, month - 1, 1)),
        to: utcDate(Date.UTC(year, month, 0)),
      };
    default: {
      const days = Number.parseInt(period, 10);
      return { from: utcDate(day - (days - 1) * 86_400_000), to: utcDate(day) };
    }
  }
}

/** RFC 4180 CSV: quoted when needed, CRLF rows. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const text = String(cell);
          return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        })
        .join(","),
    )
    .join("\r\n");
}

/** T3's limit-refusal notices, naming the Baskule limit; undefined for other refusals. */
export function limitRecoveryCopy(
  status: Pick<UsageWindowStatus, "window" | "resetsAt"> | undefined,
  now = Date.now(),
  locale: string = getLocale(),
): { title: string; description: string } | undefined {
  if (status === undefined) return undefined;
  return {
    title: windowCopy(status.window).reached,
    description: resetSentence({ resetsAt: status.resetsAt, blocked: true }, now, locale),
  };
}

const TOKEN_SUFFIX: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9 };

/** "2M", "500k", "1,000,000" or "1 000 000" → tokens; null when it is not a whole amount. */
export function parseTokens(input: string): number | null {
  const text = input.trim();
  // Thousands in groups of three: "1,000,000", "1.000.000", "1 000 000".
  if (/^\d{1,3}(?:[\s,.'_]\d{3})+$/.test(text)) return Number(text.replaceAll(/\D/g, ""));
  const match = /^(\d+(?:[.,]\d+)?)\s*([kmb]?)$/i.exec(text);
  if (!match?.[1]) return null;
  const suffix = (match[2] ?? "").toLowerCase();
  // A decimal needs a suffix ("1.5M"): tokens are whole.
  if (!suffix && /[.,]/.test(match[1])) return null;
  const number = Number(match[1].replace(",", "."));
  const tokens = Math.round(number * (TOKEN_SUFFIX[suffix] ?? 1));
  return Number.isSafeInteger(tokens) ? tokens : null;
}
