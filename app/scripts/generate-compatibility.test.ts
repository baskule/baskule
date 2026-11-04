import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
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

it("checks a large patch through the real CLI without overflowing its diff buffer", () => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "compatibility-guard-"));
  try {
    const config = NodePath.join(cwd, "gitconfig");
    NodeFS.writeFileSync(config, "");
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      COMPATIBILITY_NOOP: "false",
    };
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync(
        "git",
        [
          "-c",
          "user.name=Compatibility test",
          "-c",
          "user.email=compatibility@example.test",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd, env, encoding: "utf8" },
      );
    git("init", "-q");
    NodeFS.writeFileSync(NodePath.join(cwd, "large.txt"), "before\n");
    git("add", ".");
    git("commit", "-qm", "baseline");
    const base = git("rev-parse", "HEAD").trim();
    NodeFS.writeFileSync(
      NodePath.join(cwd, "large.txt"),
      "Ordinary repository documentation.\n".repeat(40_000),
    );
    git("add", ".");
    git("commit", "-qm", "large patch");
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./generate-compatibility.ts", import.meta.url)),
        "guard",
        base,
      ],
      { cwd, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    expect(result.status, result.stderr?.slice(0, 500)).toBe(0);
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});
