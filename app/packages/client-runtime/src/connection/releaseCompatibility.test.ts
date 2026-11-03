import { describe, expect, it } from "vite-plus/test";
import { parseCompatibilityIndex } from "@t3tools/shared/releaseCompatibility";
import { selectCompatibleRelease } from "./releaseCompatibility.ts";

const entries = parseCompatibilityIndex([
  { version: "0.5.0", minServer: "0.5.0", minClient: "0.5.0" },
  { version: "0.5.1", minServer: "0.5.0", minClient: "0.5.0" },
  { version: "0.5.2", minServer: "0.5.2", minClient: "0.5.0" },
]);
const select = (currentVersion: string, serverVersion: string, minClient = "0.5.0") =>
  selectCompatibleRelease({ entries, currentVersion, serverVersion, minClient });

describe("compatible release selection", () => {
  it("chooses the newest compatible version and follows the installation in use", () => {
    expect(select("0.5.0", "0.5.0")?.version).toBe("0.5.1");
    expect(select("0.5.0", "0.5.2")?.version).toBe("0.5.2");
    expect(select("0.5.0", "0.5.0", "0.5.2")).toBeNull();
  });
  it("never downgrades or reinstalls and refuses an unsupported server", () => {
    expect(select("0.6.0", "0.5.0")).toBeNull();
    expect(select("0.5.2", "0.5.2")).toBeNull();
    expect(select("0.5.0", "0.4.0")).toBeNull();
    expect(
      selectCompatibleRelease({
        entries: [],
        currentVersion: "0.5.0",
        serverVersion: "0.5.0",
        minClient: "0.5.0",
      }),
    ).toBeNull();
  });
});
