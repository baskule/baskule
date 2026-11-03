import * as Schema from "effect/Schema";

import release from "../release-compatibility.json" with { type: "json" };

export const ReleaseVersion = Schema.String.check(
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  ),
);
export const ReleaseCompatibility = Schema.Struct({
  version: ReleaseVersion,
  minServer: ReleaseVersion,
  minClient: ReleaseVersion,
});
export type ReleaseCompatibility = typeof ReleaseCompatibility.Type;
export const ReleaseCompatibilityIndex = Schema.Array(ReleaseCompatibility);
export const BASKULE_RELEASE = Schema.decodeSync(ReleaseCompatibility)(release);
