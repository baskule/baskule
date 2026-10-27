import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [resolve(here, "bridge.ts")],
  outfile: process.argv[2] ?? resolve(here, "../../../dist-browser/bridge.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["playwright-core", "ws"],
  banner: {
    js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
  },
  loader: { ".html": "text", ".md": "text" },
});
