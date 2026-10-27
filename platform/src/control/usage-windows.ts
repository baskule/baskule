import type { UsageAmount, UsageLimitSettings, UsageTokens, UsagePrices, UsageWindow, UsageWindowStatus } from "../../../app/packages/contracts/src/baskule-usage";

export const DAY = 86_400_000;
export const dateKey = (time: number) => new Date(time).toISOString().slice(0, 10);
export function usageWindow(window: UsageWindow, now = Date.now()) {
  const d = new Date(now);
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (window === "weekly") start -= ((d.getUTCDay() + 6) % 7) * DAY;
  if (window === "monthly") start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = window === "monthly" ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) : start + (window === "weekly" ? 7 : 1) * DAY;
  return { start, end };
}
/** Calendar months, clamped to the last day of the destination month. */
export function rawUsageCutoff(now = Date.now()) {
  const d = new Date(now);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 12, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 13, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}
export const totalTokens = (t: UsageTokens) => t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
export function usageCost(t: UsageTokens, p: UsagePrices) {
  return (t.input * p.input + (t.output + t.reasoning) * p.output + t.cacheRead * (p.cacheRead ?? p.input) + t.cacheWrite * (p.cacheWrite ?? p.input)) / 1_000_000;
}
export function limitStatuses(settings: UsageLimitSettings, used: (window: UsageWindow) => UsageAmount, now = Date.now()): UsageWindowStatus[] {
  if (!settings.enabled) return [];
  return settings.rules.map(({ window, ...limit }) => {
    const amount = used(window);
    return { window, used: amount, limit, resetsAt: new Date(usageWindow(window, now).end).toISOString(),
      blocked: (limit.tokens !== undefined && amount.tokens >= limit.tokens) || (limit.costUsd !== undefined && amount.costUsd >= limit.costUsd) };
  });
}
