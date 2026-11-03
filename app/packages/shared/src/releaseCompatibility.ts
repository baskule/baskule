import { ReleaseCompatibilityIndex, type ReleaseCompatibility } from "@t3tools/contracts";
import { compareSemverVersions } from "./semver.ts";
import * as Schema from "effect/Schema";

export function compareReleaseVersions(left: string, right: string): number {
  return compareSemverVersions(left.split("+")[0] ?? left, right.split("+")[0] ?? right);
}

const decodeCompatibilityIndex = Schema.decodeUnknownSync(ReleaseCompatibilityIndex);

export function parseCompatibilityIndex(input: unknown): ReadonlyArray<ReleaseCompatibility> {
  const entries = decodeCompatibilityIndex(input);
  let previous: ReleaseCompatibility | undefined;
  for (const entry of entries) {
    if (
      compareReleaseVersions(entry.minServer, entry.version) > 0 ||
      compareReleaseVersions(entry.minClient, entry.version) > 0 ||
      (previous &&
        (compareReleaseVersions(entry.version, previous.version) <= 0 ||
          compareReleaseVersions(entry.minServer, previous.minServer) < 0 ||
          compareReleaseVersions(entry.minClient, previous.minClient) < 0))
    ) {
      throw new Error(`Non-monotonic compatibility entry: ${entry.version}`);
    }
    previous = entry;
  }
  return entries;
}
