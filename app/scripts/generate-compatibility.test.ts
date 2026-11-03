import { describe, expect, it } from "vite-plus/test";
import {
  compatibilityFile,
  generateCompatibility,
  guardCompatibility,
} from "./generate-compatibility.ts";

const release = (version: string, minServer = version, minClient = version) => ({
  version,
  minServer,
  minClient,
});

describe("release compatibility generation", () => {
  it("bootstraps and preserves published entries when appending a reviewed window", () => {
    const first = release("0.5.0");
    expect(generateCompatibility([], first, "0.5.0")).toEqual([first]);
    const second = release("0.5.1", "0.5.0", "0.5.0");
    expect(generateCompatibility([first], second, "0.5.1")).toEqual([first, second]);
  });
  it("rejects malformed, duplicate, out-of-order and decreasing entries", () => {
    for (const entry of [
      release("broken"),
      release("0.5.0"),
      release("0.4.0"),
      release("0.5.1", "0.4.0"),
      release("0.5.1", "0.5.0", "0.4.0"),
      release("0.5.1", "0.6.0"),
    ]) {
      expect(() => generateCompatibility([release("0.5.0")], entry, entry.version)).toThrow();
    }
    expect(() => generateCompatibility([], release("0.5.0"), "0.5.1")).toThrow(/match/);
    expect(() => generateCompatibility({}, release("0.5.0"), "0.5.0")).toThrow();
    expect(() =>
      generateCompatibility([], { version: "0.5.0", minClient: "0.5.0" }, "0.5.0"),
    ).toThrow();
  });
});

describe("contract compatibility guard", () => {
  it("requires the declaration for contract and protocol edits, with an explicit no-op override", () => {
    for (const file of [
      "app/packages/contracts/src/environment.ts",
      "app/packages/contracts/src/rpc.ts",
    ]) {
      expect(() => guardCompatibility([file], false)).toThrow(/compatibility-noop/);
      expect(() => guardCompatibility([file, compatibilityFile], false)).not.toThrow();
      expect(() => guardCompatibility([file], true)).not.toThrow();
    }
    expect(() => guardCompatibility(["desktop/README.md"], false)).not.toThrow();
    expect(() =>
      guardCompatibility(["other.ts"], false, "+export const ORCHESTRATION_PROTOCOL_VERSION = 3;"),
    ).toThrow();
    expect(() =>
      guardCompatibility(
        ["other.ts"],
        false,
        '+import { ORCHESTRATION_PROTOCOL_VERSION } from "contracts";',
      ),
    ).not.toThrow();
  });
});
