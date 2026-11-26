import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderUpdateRequiredNotice,
  providerUpdateChannelLags,
} from "./providerUpdateRequiredModels.ts";

describe("formatProviderUpdateRequiredNotice", () => {
  it("does not ask for an update the install's own channel cannot deliver", () => {
    const openCode = {
      driver: ProviderDriverKind.make("opencode"),
      updateRequiredModels: [
        { slug: "opencode/big-pickle", name: "Big Pickle", minVersion: "2.1.321" },
      ],
      versionAdvisory: {
        status: "current" as const,
        currentVersion: "2.1.311",
        latestVersion: "2.1.311",
        updateCommand: "npm install -g @opencode/cli@latest",
        canUpdate: true,
        checkedAt: null,
        message: null,
      },
    };

    const notice = formatProviderUpdateRequiredNotice(openCode);

    expect(notice).toBe(
      "Using Big Pickle requires OpenCode v2.1.321 or newer, but the newest this install can update to is v2.1.311. Install OpenCode another way or wait for a newer release.",
    );
    expect(providerUpdateChannelLags(openCode)).toBe(true);
    expect(
      formatProviderUpdateRequiredNotice({
        ...openCode,
        versionAdvisory: { ...openCode.versionAdvisory, updateCommand: null },
      }),
    ).toBe(
      "Using Big Pickle requires OpenCode v2.1.321 or newer, but the newest this install can update to is v2.1.311. Install OpenCode another way or wait for a newer release.",
    );
    expect(
      formatProviderUpdateRequiredNotice({
        ...openCode,
        versionAdvisory: { ...openCode.versionAdvisory, latestVersion: "2.1.330" },
      }),
    ).toBe("Update OpenCode to v2.1.321 or newer to use Big Pickle.");
    expect(
      providerUpdateChannelLags({
        ...openCode,
        versionAdvisory: { ...openCode.versionAdvisory, latestVersion: "2.1.330" },
      }),
    ).toBe(false);
  });
});
