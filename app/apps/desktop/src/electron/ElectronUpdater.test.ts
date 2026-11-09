import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { autoUpdater } from "electron-updater";
import { autoUpdater as nativeUpdater } from "electron";

import { make } from "./ElectronUpdater.ts";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { autoUpdater: new EventEmitter() };
});
vi.mock("electron-updater", () => ({
  autoUpdater: { autoInstallOnAppQuit: false, channel: "latest", downloadUpdate: vi.fn() },
}));

function setup() {
  autoUpdater.autoInstallOnAppQuit = false;
  vi.mocked(autoUpdater.downloadUpdate).mockReset().mockResolvedValue([]);
  return {
    [Symbol.dispose]() {
      nativeUpdater.removeAllListeners();
    },
  };
}

describe("install on quit", () => {
  it.effect.each(["linux", "win32"] as const)("arms the cached installer on %s", (platform) =>
    Effect.gen(function* () {
      using _setup = setup();
      yield* make.prepareInstallOnQuit;
      assert.isTrue(autoUpdater.autoInstallOnAppQuit);
      assert.equal(vi.mocked(autoUpdater.downloadUpdate).mock.calls.length, 2);
    }).pipe(Effect.provideService(HostProcess.Platform, platform)),
  );

  it.effect("waits for native macOS staging, then removes its listeners", () =>
    Effect.gen(function* () {
      using _setup = setup();
      const stageRequested = Promise.withResolvers<void>();
      vi.mocked(autoUpdater.downloadUpdate).mockImplementation(async () => {
        if (autoUpdater.autoInstallOnAppQuit) {
          stageRequested.resolve();
        }
        return [];
      });
      const staging = yield* make.prepareInstallOnQuit.pipe(Effect.forkScoped);
      yield* Effect.promise(() => stageRequested.promise);
      assert.equal(nativeUpdater.listenerCount("update-downloaded"), 1);
      nativeUpdater.emit("update-downloaded");
      yield* Fiber.join(staging);
      assert.isTrue(autoUpdater.autoInstallOnAppQuit);
      assert.equal(nativeUpdater.listenerCount("update-downloaded"), 0);
      assert.equal(nativeUpdater.listenerCount("error"), 0);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "darwin")),
  );

  it.effect("disarms installation if macOS staging fails", () =>
    Effect.gen(function* () {
      using _setup = setup();
      vi.mocked(autoUpdater.downloadUpdate).mockImplementation(async () => {
        if (autoUpdater.autoInstallOnAppQuit)
          nativeUpdater.emit("error", new Error("bad signature"));
        return [];
      });
      const result = yield* make.prepareInstallOnQuit.pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.isFalse(autoUpdater.autoInstallOnAppQuit);
      assert.equal(nativeUpdater.listenerCount("error"), 0);
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin")),
  );

  it.effect("bounds a stalled macOS stage so quitting can continue", () =>
    Effect.gen(function* () {
      using _setup = setup();
      const stageRequested = Promise.withResolvers<void>();
      vi.mocked(autoUpdater.downloadUpdate).mockImplementation(async () => {
        if (autoUpdater.autoInstallOnAppQuit) {
          stageRequested.resolve();
        }
        return [];
      });
      const staging = yield* make.prepareInstallOnQuit.pipe(Effect.result, Effect.forkScoped);
      yield* Effect.promise(() => stageRequested.promise);
      yield* TestClock.adjust("30 seconds");
      assert.equal((yield* Fiber.join(staging))._tag, "Failure");
      assert.isFalse(autoUpdater.autoInstallOnAppQuit);
      assert.equal(nativeUpdater.listenerCount("update-downloaded"), 0);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "darwin")),
  );
});
