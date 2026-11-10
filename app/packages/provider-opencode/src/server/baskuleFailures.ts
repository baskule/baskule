import * as Schema from "effect/Schema";
import { BASKULE_AI_NOT_CONFIGURED } from "@t3tools/contracts/baskule";
import { UsageWindowStatusSchema } from "@t3tools/contracts/baskule-usage";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

const decodeStatus = Schema.decodeUnknownSync(UsageWindowStatusSchema);

/** OpenCode's declared 400 envelope keeps its SDK error and T3's reusable-thread behavior intact. */
export function baskuleUsageFailure(cause: unknown) {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("kind" in cause) ||
    cause.kind !== "usage_limit_reached" ||
    !("field" in cause) ||
    typeof cause.field !== "string"
  )
    return undefined;
  try {
    const status = decodeStatus(JSON.parse(cause.field));
    return {
      ...makeProviderFailure({
        class: "usage_limit",
        code: "usage_limit_reached",
        retryable: false,
        resetAt: status.resetsAt,
        message: `Your ${status.window} usage limit has been reached. It resets at ${status.resetsAt}.`,
      }),
      usageWindowStatus: status,
    };
  } catch {
    return undefined;
  }
}

/** The installation has no AI provider yet: the turn names who can fix it instead of a generic provider error. */
export function baskuleSetupFailure(cause: unknown) {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("kind" in cause) ||
    cause.kind !== BASKULE_AI_NOT_CONFIGURED.kind
  )
    return undefined;
  return makeProviderFailure({
    class: "provider_error",
    code: BASKULE_AI_NOT_CONFIGURED.kind,
    retryable: false,
    message: BASKULE_AI_NOT_CONFIGURED.message,
  });
}

/** A location build can be retried after the cell invalidates its cached tools. */
export function baskuleLocationFailure(cause: unknown) {
  if (typeof cause !== "object" || cause === null || !("kind" in cause) ||
    (cause.kind !== "location_tools_unavailable" && cause.kind !== "location_tools_failed"))
    return undefined;
  return makeProviderFailure({
    class: "provider_error",
    code: cause.kind,
    retryable: cause.kind === "location_tools_unavailable",
    message: cause.kind === "location_tools_unavailable"
      ? "Chat tools could not finish connecting. Please try again."
      : "Chat tools could not connect. Contact an administrator.",
  });
}
