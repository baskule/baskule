import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
  resolveRequiredUpdateView,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
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
  message: null,
  errorContext: null,
  canRetry: false,
  requiredVersion: null,
};

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("desktop update UI helpers", () => {
  it.each(["owner/repo/extra", "owner#notes/repo", "owner/repo?tab=notes"])(
    "falls back to upstream for an invalid configured repository: %s",
    (repository) => {
      expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBe(
        "https://github.com/baskule/baskule/releases",
      );
      expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBe(
        "https://github.com/baskule/baskule/releases/tag/v1.2.3",
      );
    },
  );
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateActionError", () => {
  const required = "You must update Baskule to 1.1.0 or newer to use this installation.";
  it.each([
    ["an accepted install that is restarting", { status: "downloaded", message: required }, null],
    ["a failed install", { errorContext: "install", message: "spawn EACCES" }, "spawn EACCES"],
    [
      "a failed download",
      { status: "available", errorContext: "download", message: "timeout" },
      "timeout",
    ],
  ] as const)("reports %s", (_name, overrides, expected) => {
    expect(
      getDesktopUpdateActionError({
        accepted: true,
        completed: false,
        state: { ...baseState, ...overrides },
      }),
    ).toBe(expected);
  });
});

describe("resolveRequiredUpdateView", () => {
  const required = { ...baseState, requiredVersion: "1.1.0" };
  it.each([
    ["no requirement", baseState, undefined, null],
    [
      "a managed machine",
      required,
      "Acme manages T3 Code updates.",
      { kind: "managed", detail: "Acme manages T3 Code updates." },
    ],
    [
      "an updater that is off",
      { ...required, enabled: false, status: "disabled", message: "Use the AppImage." },
      undefined,
      { kind: "manual", detail: "Use the AppImage." },
    ],
    [
      "an updater a managed policy turns off",
      {
        ...required,
        enabled: false,
        status: "disabled",
        message: "Acme manages T3 Code updates.",
        blockedByPolicy: "updates",
      },
      undefined,
      { kind: "managed", detail: "Acme manages T3 Code updates." },
    ],
    ["a check in progress", { ...required, status: "checking" }, undefined, { kind: "checking" }],
    [
      "an installation change whose check did not start",
      required,
      undefined,
      { kind: "retry", error: null },
    ],
    [
      "an available release",
      { ...required, status: "available", availableVersion: "1.1.0", message: "You must update." },
      undefined,
      { kind: "update", action: "download", error: null },
    ],
    [
      "a failed download",
      {
        ...required,
        status: "available",
        availableVersion: "1.1.0",
        errorContext: "download",
        message: "timeout",
      },
      undefined,
      { kind: "update", action: "download", error: "timeout" },
    ],
    [
      "a downloaded release",
      { ...required, status: "downloaded", availableVersion: "1.1.0", downloadedVersion: "1.1.0" },
      undefined,
      { kind: "update", action: "install", error: null },
    ],
    [
      "a download in progress",
      { ...required, status: "downloading", availableVersion: "1.1.0", downloadPercent: 42 },
      undefined,
      { kind: "downloading", percent: 42 },
    ],
    [
      "no compatible release",
      { ...required, status: "up-to-date", message: "You must update." },
      undefined,
      { kind: "retry", error: null },
    ],
    [
      "a failed check",
      { ...required, status: "error", errorContext: "check", message: "offline" },
      undefined,
      { kind: "retry", error: "offline" },
    ],
  ] as const)("offers the right step for %s", (_name, state, denial, expected) => {
    expect(resolveRequiredUpdateView(state, denial)).toEqual(expected);
  });
});
