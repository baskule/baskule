import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLUGIN_ERROR_CODES } from "../../../app/packages/contracts/src/baskule-plugins";

describe("plugin error contract", () => {
  it("keeps route and outbound errors in the typed error map", () => {
    const modules = ["control/plugins.ts", "control/connections.ts", "control/connection-oauth.ts", "control/plugin-import.ts", "control/groups.ts", "shared/plugin-outbound.ts",
      ...readdirSync(new URL("../../src/control/registries/", import.meta.url)).filter(name => name.endsWith(".ts")).map(name => `control/registries/${name}`)];
    for (const file of modules) {
      const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/new HttpError\(/);
      for (const [, code] of source.matchAll(/pluginError\(\d+, "([a-z_]+)"/g)) expect(PLUGIN_ERROR_CODES, `${file}: ${code}`).toContain(code);
    }
  });
});
