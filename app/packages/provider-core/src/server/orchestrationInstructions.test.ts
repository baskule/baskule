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

  // baskule: the agent's computer cannot read files written by a SpaceCell.
  it("only suggests file delivery when the agent can use secret files", () => {
    assert.include(t3OrchestrationSystemPrompt(true, false), 'delivery: "file"');
    const hosted = t3OrchestrationSystemPrompt(true, false, { supportsSecretFiles: false });
    assert.include(hosted, "`request_secret`");
    assert.notInclude(hosted, 'delivery: "file"');
    assert.notInclude(hosted, "sudo password");
  });
});
