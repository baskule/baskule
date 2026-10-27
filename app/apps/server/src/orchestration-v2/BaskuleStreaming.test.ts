// baskule: word-level streaming split.
import { describe, expect, it } from "@effect/vitest";

import { splitAssistantTextAtWord } from "./BaskuleStreaming.ts";

describe("splitAssistantTextAtWord", () => {
  it("delivers a single paragraph up to its last complete word", () => {
    expect(splitAssistantTextAtWord("The lighthouse keeper wa")).toEqual({
      ready: "The lighthouse keeper ",
      rest: "wa",
    });
  });

  it("keeps an open code fence buffered at the paragraph boundary", () => {
    const text = "Intro line.\n\n```ts\nconst a = 1;\nconst b";
    expect(splitAssistantTextAtWord(text).ready).toBe("Intro line.\n\n");
  });

  it("streams words again once the fence closes", () => {
    const text = "```\ncode\n```\nAfter the code bl";
    expect(splitAssistantTextAtWord(text).ready).toBe("```\ncode\n```\nAfter the code ");
  });
});
