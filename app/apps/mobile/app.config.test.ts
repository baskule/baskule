import { afterEach, expect, it, vi } from "vite-plus/test";
import { compileModsAsync, withPlugins } from "expo/config-plugins";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "dev.baskule.app"],
  ["development", "dev.baskule.app.dev"],
  ["preview", "dev.baskule.app.preview"],
  ["production", "dev.baskule.app"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
});

it("keeps dictation permissions after the audio, camera and image picker plugins run", async () => {
  const config = await loadConfig("development");
  const mediaPlugins = new Set(["expo-audio", "expo-camera", "expo-image-picker"]);
  const plugins: Parameters<typeof withPlugins>[1] = [];
  for (const plugin of config.plugins ?? []) {
    const name = typeof plugin === "string" ? plugin : plugin[0];
    if (name && mediaPlugins.has(name)) {
      plugins.push(typeof plugin === "string" ? plugin : [name, plugin[1]]);
    }
  }
  const result = await compileModsAsync(
    withPlugins({ ...config, _internal: { projectRoot: import.meta.dirname } }, plugins),
    { projectRoot: import.meta.dirname, platforms: ["android", "ios"], introspect: true },
  );
  const native = result._internal?.modResults;
  expect(native?.android.manifest.manifest["uses-permission"]).toContainEqual({
    $: { "android:name": "android.permission.RECORD_AUDIO" },
  });
  expect(native?.ios.infoPlist.NSMicrophoneUsageDescription).toBeTruthy();
});
