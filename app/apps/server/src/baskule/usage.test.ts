import { describe, expect, it } from "vite-plus/test";
import {
  baskuleSetupFailure,
  baskuleUsageFailure,
} from "../../../../packages/provider-opencode/src/server/baskuleUsage.ts";
import { usageAuthor } from "./usageAuthor.ts";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

describe("usage attribution and errors", () => {
  it("carries a readable limit error, code, reset time and status through provider failures", () => {
    const status = {
      window: "weekly",
      used: { tokens: 100, costUsd: 1 },
      limit: { tokens: 100 },
      resetsAt: "2026-10-26T00:00:00.000Z",
      blocked: true,
    };
    expect(
      baskuleUsageFailure({
        _tag: "InvalidRequestError",
        kind: "usage_limit_reached",
        field: JSON.stringify(status),
      }),
    ).toMatchObject({
      class: "usage_limit",
      code: "usage_limit_reached",
      resetAt: status.resetsAt,
      retryable: false,
      usageWindowStatus: status,
      message: expect.stringContaining("resets at"),
    });
    expect(baskuleUsageFailure({ kind: "usage_limit_reached", field: "broken" })).toBeUndefined();
    expect(baskuleUsageFailure(new Error("other provider error"))).toBeUndefined();
  });
  it("tells members who can choose an AI provider when the installation has none", () => {
    expect(
      baskuleSetupFailure({
        _tag: "InvalidRequestError",
        kind: "ai_not_configured",
        message: "ignored provider text",
      }),
    ).toEqual({
      class: "provider_error",
      code: "ai_not_configured",
      retryable: false,
      message:
        "No AI model is set up yet. An administrator needs to choose an AI provider in Admin → AI → Models.",
    });
    expect(baskuleSetupFailure({ kind: "usage_limit_reached" })).toBeUndefined();
    expect(baskuleSetupFailure(new Error("other provider error"))).toBeUndefined();
  });
  it("assigns agent-created schedules to the active turn author, even after someone else queues a message", () => {
    const author = { id: "alice", name: "Alice" };
    const projection = {
      thread: {},
      runs: [
        { status: "waiting", userMessageId: "original" },
        { status: "queued", userMessageId: "queued" },
      ],
      messages: [
        { id: "original", author },
        { id: "queued", author: { id: "bob", name: "Bob" } },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(usageAuthor(projection)).toEqual(author);
    expect(usageAuthor(undefined)).toBeUndefined();
  });
});
