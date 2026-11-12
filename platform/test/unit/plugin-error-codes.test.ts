import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("plugin error contract", () => {
  it("keeps route and outbound errors in the typed error map", () => {
    const plugins = ["admin", "catalog", "connections", "fetch", "github", "index", "oauth", "package", "providers", "state", "store"].map(name => `control/plugins/${name}.ts`);
    for (const file of ["control/groups.ts", "shared/plugin-outbound.ts", ...plugins]) {
      const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/new HttpError\(/);
    }
  });
});
