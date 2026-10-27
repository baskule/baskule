export type UsageWindow = "daily" | "weekly" | "monthly";
export interface UsageAmount { tokens: number; costUsd: number }
export interface UsageLimitRule { window: UsageWindow; tokens?: number; costUsd?: number }
export interface UsageLimitSettings { enabled: boolean; rules: UsageLimitRule[] }
export interface UsageWindowStatus {
  window: UsageWindow;
  used: UsageAmount;
  limit: { tokens?: number; costUsd?: number };
  resetsAt: string;
  blocked: boolean;
}
export interface UsageTokens {
  input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number;
}
/** USD per million tokens. Reasoning uses the output rate; absent cache rates use input. */
export interface UsagePrices { input: number; output: number; cacheRead?: number; cacheWrite?: number }
export interface UsageRecord {
  messageId: string;
  turnId: string;
  userId: string;
  spaceId: string;
  chatId: string;
  provider: string;
  model: string;
  occurredAt: string;
  tokens: UsageTokens;
  /** Installation-configured prices at turn start, never a later catalog price. */
  prices: UsagePrices;
  costUsd: number;
}
export interface UsageDaily extends UsageAmount { date: string; turns: number }
export interface UsageModel extends UsageAmount { provider: string; model: string }
export interface MyUsage {
  limits: UsageWindowStatus[];
  totals: { today: UsageAmount; week: UsageAmount; month: UsageAmount };
  daily: UsageDaily[];
  /** Same 90 calendar days as daily, including today. */
  byModel: UsageModel[];
}
export interface UsageCounts extends UsageAmount { chats: number; turns: number }
export interface AdminUsage {
  /** UTC dates, inclusive. Defaults to the last 90 calendar days including today. */
  from: string; to: string;
  totals: UsageCounts & { activeUsers: number };
  byUser: (UsageCounts & { userId: string; name: string | null; email: string | null })[];
  byModel: (UsageModel & { turns: number })[];
  bySpace: (UsageCounts & { spaceId: string; name: string | null })[];
  daily: UsageDaily[];
}
export interface ModelPriceSuggestion {
  provider: string; model: string; prices: UsagePrices;
  source: "models.dev" | "snapshot";
  fetchedAt: string;
}
export interface UsageLimitError {
  error: "usage_limit_reached";
  code: "usage_limit_reached";
  message: string;
  status: UsageWindowStatus;
}

// The provider failure transports the same status through T3's typed event stream.
import * as Schema from "effect/Schema";
export const UsageWindowStatusSchema = Schema.Struct({
  window: Schema.Literals(["daily", "weekly", "monthly"]),
  used: Schema.Struct({ tokens: Schema.Number, costUsd: Schema.Number }),
  limit: Schema.Struct({ tokens: Schema.optional(Schema.Number), costUsd: Schema.optional(Schema.Number) }),
  resetsAt: Schema.String,
  blocked: Schema.Boolean,
});
