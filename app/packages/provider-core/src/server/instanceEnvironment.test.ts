import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { mergeProviderInstanceEnvironment } from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it.effect("passes values through without shell expansion", () =>
    Effect.gen(function* () {
      const baseEnv = { HOME: "/home/ada" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
      expect(baseEnv).toEqual({ HOME: "/home/ada" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
          ],
          { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        PATH: "/bin",
      });
    }),
  );

  const appDir = "/tmp/.mount_T3-CodXXXX";
  const systemLibraryPath = "/home/ada/lib:/home/ada/.local/lib";
  it.effect.each([
    {
      label: "without configured variables",
      environment: undefined,
      libraryPath: `${appDir}/usr/lib;${systemLibraryPath}`,
      keptLibraryPath: systemLibraryPath,
    },
    {
      label: "alongside configured variables",
      environment: [{ name: "CUSTOM_VALUE", value: "set", sensitive: false }],
      libraryPath: `${appDir}/usr/lib;${systemLibraryPath}`,
      keptLibraryPath: systemLibraryPath,
    },
    {
      label: "keeping a lone current-directory entry",
      environment: undefined,
      libraryPath: `${appDir}/usr/lib:`,
      keptLibraryPath: ":",
    },
  ])(
    "drops the AppImage runtime from the inherited environment $label",
    ({ environment, libraryPath, keptLibraryPath }) =>
      Effect.gen(function* () {
        const merged = yield* mergeProviderInstanceEnvironment(environment, {
          APPIMAGE: "/home/ada/T3-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/ada/T3-Code.AppImage",
          OWD: "/home/ada",
          PATH: `${appDir}:${appDir}/usr/sbin::/usr/bin`,
          LD_LIBRARY_PATH: libraryPath,
          XDG_DATA_DIRS: `${appDir}/usr/share/:/usr/share`,
          GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
        });

        expect(merged).toEqual({
          PATH: ":/usr/bin",
          LD_LIBRARY_PATH: keptLibraryPath,
          XDG_DATA_DIRS: "/usr/share",
          ...(environment ? { CUSTOM_VALUE: "set" } : {}),
        });
      }),
  );

  it.effect("replaces every inherited spelling of a name on Windows, and only there", () =>
    Effect.gen(function* () {
      const merge = (platform: NodeJS.Platform) =>
        mergeProviderInstanceEnvironment(
          [{ name: "Https_Proxy", value: "http://gateway", sensitive: false }],
          { HTTPS_PROXY: "http://mine", PATH: "/bin" },
        ).pipe(Effect.provideService(HostProcess.Platform, platform));
      // Upper case sorts first, so it also wins where a spawn merges the parent environment back.
      expect(yield* merge("win32")).toEqual({ HTTPS_PROXY: "http://gateway", PATH: "/bin" });
      expect(yield* merge("linux")).toEqual({
        HTTPS_PROXY: "http://mine",
        Https_Proxy: "http://gateway",
        PATH: "/bin",
      });
    }),
  );
});
