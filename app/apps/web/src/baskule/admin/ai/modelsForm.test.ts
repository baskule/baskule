import { describe, expect, it } from "vite-plus/test";

import { connectionCheckOf, limitsAreValid, SAVED_KEY_MASK, typedKey } from "./modelsForm";

describe("AI models form", () => {
  it("replaces the saved key's dots with what is typed or pasted", () => {
    expect(typedKey(`${SAVED_KEY_MASK}x`, true)).toBe("x");
    expect(typedKey("sk-pasted", true)).toBe("sk-pasted");
    // Deleting one dot clears the field: the saved key is never partly edited.
    expect(typedKey(SAVED_KEY_MASK.slice(1), true)).toBe("");
    expect(typedKey("plain•text", false)).toBe("plain•text");
  });

  it("asks about the saved key until one is typed, and never sends one for OpenCode", () => {
    expect(connectionCheckOf("mistral", "https://api.mistral.ai/v1", null, " small ")).toEqual({
      providerId: "mistral",
      baseUrl: "https://api.mistral.ai/v1",
      modelId: "small",
    });
    expect(connectionCheckOf("custom", "https://llm.test/v1", "", "m")).toMatchObject({
      apiKey: "",
    });
    expect(
      connectionCheckOf("opencode", "https://opencode.test/v1", "typed", "m"),
    ).not.toHaveProperty("apiKey");
    expect(connectionCheckOf("custom", "llm.test/v1", "k", "m")).toBeNull();
    expect(connectionCheckOf("custom", "https://llm.test/v1", "k", " ")).toBeNull();
  });

  it("accepts the token limits the ControlCell accepts", () => {
    expect(limitsAreValid({ context: 200_000, output: 16_000 })).toBe(true);
    expect(limitsAreValid({ context: 16_000, output: 16_000 })).toBe(false);
    expect(limitsAreValid({ context: 512, output: 100 })).toBe(false);
    expect(limitsAreValid({ context: 200_000.5, output: 1 })).toBe(false);
  });
});
