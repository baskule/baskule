import type { ReleaseCompatibility } from "@t3tools/contracts";
import { compareReleaseVersions } from "@t3tools/shared/releaseCompatibility";

export function selectCompatibleRelease(input: {
  readonly entries: ReadonlyArray<ReleaseCompatibility>;
  readonly currentVersion: string;
  readonly serverVersion: string;
  readonly minClient: string;
}): ReleaseCompatibility | null {
  return input.entries.reduce<ReleaseCompatibility | null>((selected, entry) => {
    if (
      compareReleaseVersions(entry.version, input.currentVersion) <= 0 ||
      compareReleaseVersions(entry.minServer, input.serverVersion) > 0 ||
      compareReleaseVersions(input.minClient, entry.version) > 0 ||
      (selected && compareReleaseVersions(entry.version, selected.version) <= 0)
    )
      return selected;
    return entry;
  }, null);
}
