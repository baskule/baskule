import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { BASKULE_AI_PROVIDERS } from "../../../../../app/packages/contracts/src/baskule";
import { settingsSchema } from "../../../control/settings";
import { embeddedAgent } from "../../build.mjs";

it("excludes the disabled SDK catalog while preserving its public exports", async () => {
  const entry = fileURLToPath(import.meta.resolve("@opencode/core/models-dev"));
  const options = {
    entryPoints: [entry],
    bundle: true,
    packages: "external",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  } satisfies Parameters<typeof build>[0];
  const original = await build(options);
  const trimmed = await build({ ...options, plugins: [embeddedAgent] });
  const originalOutput = original.outputFiles[0]!;
  const trimmedOutput = trimmed.outputFiles[0]!;
  expect(originalOutput.contents.length - trimmedOutput.contents.length).toBeGreaterThan(6_000_000);
  expect(trimmedOutput.text).toContain('var snapshot_default = "{}";');
  const imports = Object.values(trimmed.metafile!.outputs)[0]!.imports
    .map(item => item.path).filter(path => path.startsWith("@opencode/ai/providers/"));
  const allowed = [...new Set(Object.values(BASKULE_AI_PROVIDERS).map(provider => provider.package))];
  for (const pkg of allowed) expect(imports).toContain(pkg);
  expect(imports.every(pkg => allowed.some(root => pkg === root || pkg.startsWith(`${root}/`)))).toBe(true);
  const registry = /var builtins = (?:\/\*[^*]*\*\/ )?new Map\(\[([\s\S]*?)\n\]\);/;
  const keys = (text: string) => {
    const entries = text.match(registry)?.[1];
    if (!entries) throw new Error("SDK provider registry missing from the built module");
    return [...entries.matchAll(/\[\s*"([^"]+)"/g)].map(match => match[1]);
  };
  expect(keys(trimmedOutput.text)).toEqual(keys(originalOutput.text));
  const declaration = trimmedOutput.text.match(registry)?.[0];
  if (!declaration) throw new Error("SDK provider registry missing from the built module");
  await expect(runInNewContext(`${declaration}; builtins.get("@opencode/ai/providers/amazon-bedrock")()`))
    .rejects.toThrow("Provider package @opencode/ai/providers/amazon-bedrock is unavailable in Baskule");
  expect(Object.values(trimmed.metafile!.outputs)[0]!.exports).toEqual(
    Object.values(original.metafile!.outputs)[0]!.exports,
  );
});

it("keeps the accepted admin provider IDs aligned with the public provider package mapping", () => {
  expect([...settingsSchema.shape.ai.unwrap().shape.providerId.options].sort()).toEqual(
    Object.keys(BASKULE_AI_PROVIDERS).sort(),
  );
});
