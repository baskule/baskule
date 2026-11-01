import { build } from "esbuild";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
await build({
  entryPoints: [NodePath.resolve(here, "bridge.ts")],
  outfile: process.argv[2] ?? NodePath.resolve(here, "../../../dist-browser/bridge.mjs"),
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
