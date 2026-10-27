import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatProviderUpdateRequiredNotice } from "./providerUpdateRequiredModels.ts";

describe("formatProviderUpdateRequiredNotice", () => {
  it("names the CLI and the version that unlocks every listed model", () => {
    expect(
      formatProviderUpdateRequiredNotice({
        driver: ProviderDriverKind.make("opencode"),
        updateRequiredModels: [
          { slug: "a", name: "Model A", minVersion: "2.1.9" },
          { slug: "b", name: "Model B", minVersion: "2.1.10" },
        ],
      }),
    ).toBe("Update OpenCode to v2.1.10 or newer to use Model A and Model B.");
    expect(
      formatProviderUpdateRequiredNotice({ driver: ProviderDriverKind.make("opencode") }),
    ).toBeNull();
  });

  it("names only the gated models a search matches", () => {
    const provider = {
      driver: ProviderDriverKind.make("opencode"),
      updateRequiredModels: [
        { slug: "example-a", name: "Model A", minVersion: "2.1.9" },
        { slug: "example-b", name: "Model B", minVersion: "2.1.10" },
      ],
    };
    expect(formatProviderUpdateRequiredNotice(provider, " model a ")).toBe(
      "Update OpenCode to v2.1.9 or newer to use Model A.",
    );
    expect(formatProviderUpdateRequiredNotice(provider, "gpt")).toBeNull();
  });

  it("names the release, not a prerelease of it", () => {
    expect(
      formatProviderUpdateRequiredNotice({
        driver: ProviderDriverKind.make("opencode"),
        updateRequiredModels: [
          { slug: "a", name: "A", minVersion: "2.1.0-beta" },
          { slug: "b", name: "B", minVersion: "2.1.0" },
        ],
      }),
    ).toBe("Update OpenCode to v2.1.0 or newer to use A and B.");
  });
});
