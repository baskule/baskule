import * as Schema from "effect/Schema";
import { UsageWindowStatusSchema } from "@t3tools/contracts/baskule-usage";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

const decodeStatus = Schema.decodeUnknownSync(UsageWindowStatusSchema);

/** OpenCode's declared 400 envelope keeps its SDK error and T3's reusable-thread behavior intact. */
export function baskuleUsageFailure(cause: unknown) {
  if (typeof cause !== "object" || cause === null || !("kind" in cause) || cause.kind !== "usage_limit_reached" || !("field" in cause) || typeof cause.field !== "string") return undefined;
  try {
    const status = decodeStatus(JSON.parse(cause.field));
    return { ...makeProviderFailure({ class: "usage_limit", code: "usage_limit_reached", retryable: false, resetAt: status.resetsAt,
      message: `Your ${status.window} usage limit has been reached. It resets at ${status.resetsAt}.` }), usageWindowStatus: status };
  } catch { return undefined; }
}
