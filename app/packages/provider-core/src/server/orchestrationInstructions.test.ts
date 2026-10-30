import { assert, describe, it } from "@effect/vitest";
import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("OpenCode orchestration instructions", () => {
  it("includes device guidance only when the MCP session grants device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));
  });
});
