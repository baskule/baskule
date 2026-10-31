import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("plugin error contract", () => {
  it("keeps route and outbound errors in the typed error map", () => {
    const modules = ["control/plugins.ts", "control/connections.ts", "control/connection-oauth.ts", "control/plugin-import.ts", "control/groups.ts", "shared/plugin-outbound.ts",
      "control/plugin-source.ts"];
    for (const file of modules) {
      const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/new HttpError\(/);
    }
  });
});
