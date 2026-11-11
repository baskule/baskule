import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { type DesktopUpdateState, DesktopUpdateStateSchema } from "./ipc.ts";

const encodeUpdateState = Schema.encodeUnknownSync(DesktopUpdateStateSchema);

describe("DesktopUpdateStateSchema", () => {
  it("keeps every update state field across IPC", () => {
    const state = {
      enabled: false,
      status: "disabled",
      channel: "latest",
      currentVersion: "1.0.0",
      hostArch: "x64",
      appArch: "x64",
      runningUnderArm64Translation: false,
      availableVersion: null,
      downloadedVersion: null,
      releaseNotes: [],
      omittedReleaseCount: 0,
      downloadPercent: null,
      checkedAt: null,
      message: "Example Corp manages T3 Code updates.",
      errorContext: null,
      canRetry: false,
      requiredVersion: "1.1.0",
      notAppliedVersion: "1.0.1",
      blockedByPolicy: "updates",
    } satisfies Required<DesktopUpdateState>;
    expect(encodeUpdateState(state)).toEqual(state);
  });
});
