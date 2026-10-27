import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    {
      name: "sql-as-text",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".sql")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      },
    },
  ],
  resolve: {
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/support/cloudflare-workers.ts", import.meta.url)) },
  },
  test: {
    include: ["test/unit/**/*.test.ts", "src/**/test/unit/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
