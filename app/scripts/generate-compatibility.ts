// @effect-diagnostics nodeBuiltinImport:off -- Release CLI uses Node filesystem and git.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import { ReleaseCompatibility } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parseCompatibilityIndex } from "@t3tools/shared/releaseCompatibility";

export const compatibilityFile = "app/packages/contracts/release-compatibility.json";

const decodeCompatibility = Schema.decodeUnknownSync(ReleaseCompatibility);

export function generateCompatibility(previous: unknown, current: unknown, version: string) {
  const entry = decodeCompatibility(current);
  if (entry.version !== version)
    throw new Error("Compatibility declaration must match release version");
  return parseCompatibilityIndex([...parseCompatibilityIndex(previous), entry]);
}

export function guardCompatibility(files: ReadonlyArray<string>, override: boolean, diff = "") {
  if (
    !override &&
    (files.some((file) => file.startsWith("app/packages/contracts/src/")) ||
      /^[+-](?![+-]).*\bconst\s+ORCHESTRATION_PROTOCOL_VERSION\b/m.test(diff)) &&
    !files.includes(compatibilityFile)
  )
    throw new Error(
      `Contract edits require ${compatibilityFile}; no-op edits may use the compatibility-noop PR label.`,
    );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === "guard" && first) {
    const files = NodeChildProcess.execFileSync("git", ["diff", "--name-only", `${first}...HEAD`], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    guardCompatibility(
      files,
      process.env.COMPATIBILITY_NOOP === "true",
      NodeChildProcess.execFileSync("git", ["diff", "--unified=0", `${first}...HEAD`], {
        encoding: "utf8",
      }),
    );
  } else if (command === "generate" && first && second && third) {
    const current: unknown = JSON.parse(
      NodeFS.readFileSync(
        new URL("../packages/contracts/release-compatibility.json", import.meta.url),
        "utf8",
      ),
    );
    const previous: unknown = JSON.parse(NodeFS.readFileSync(first, "utf8"));
    NodeFS.writeFileSync(
      third,
      `${JSON.stringify(generateCompatibility(previous, current, second), null, 2)}\n`,
    );
  } else
    throw new Error(
      "Usage: generate-compatibility.ts generate PREVIOUS VERSION OUTPUT | guard BASE",
    );
}
