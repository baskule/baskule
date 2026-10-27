import type { AdminUsage, ModelPriceSuggestion, MyUsage, UsageLimitSettings } from "@t3tools/contracts/baskule-usage";
import { request } from "../api";
export type * from "@t3tools/contracts/baskule-usage";

export const usageApi = {
  me: () => request<MyUsage>("GET", "/api/baskule/usage/me"),
  admin: (range: { from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (range.from) q.set("from", range.from);
    if (range.to) q.set("to", range.to);
    return request<AdminUsage>("GET", `/api/baskule/admin/usage?${q}`);
  },
  limits: () => request<UsageLimitSettings>("GET", "/api/baskule/admin/usage/limits"),
  setLimits: (settings: UsageLimitSettings) => request<UsageLimitSettings>("PUT", "/api/baskule/admin/usage/limits", settings),
  prices: (provider: string, model: string) => request<ModelPriceSuggestion>("GET", `/api/baskule/admin/models/prices?${new URLSearchParams({ provider, model })}`),
};
