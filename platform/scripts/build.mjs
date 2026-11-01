#!/usr/bin/env node
// Builds the celld app: dist/worker.js (esbuild bundle) + dist/web (static bundle) + dist/web/downloads.
//   BASKULE_WEB_DIR        directory of the web build to serve (default: web-placeholder/)
//   BASKULE_DOWNLOADS_DIR  directory whose files are published under /downloads/ (default: none)
//   BASKULE_ENTRY          Worker entry (default: src/worker.ts; the integration test uses its own)
//   BASKULE_OUT            output dir (default: dist)
//   BASKULE_MINIFY=1       minify the Worker, keeping function and class names (production: deploy/build.sh)
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules, createRequire } from "node:module";
import { nativeEffectContinuations } from "../../app/apps/server/src/baskule/workerd/nativeEffectContinuations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, process.env.BASKULE_OUT ?? "dist");
const entry = resolve(root, process.env.BASKULE_ENTRY ?? "src/worker.ts");
const webDir = resolve(root, process.env.BASKULE_WEB_DIR ?? "web-placeholder");
const dlDir = process.env.BASKULE_DOWNLOADS_DIR ? resolve(root, process.env.BASKULE_DOWNLOADS_DIR) : null;
// Minified, a cold isolate parses ~20 MB instead of ~44 MB (celld deploy re-bundles it unminified: ~24 MB). Names
// are kept so stack traces in the celld logs stay readable.
const minify = process.env.BASKULE_MINIFY === "1";

mkdirSync(out, { recursive: true });
const t0 = Date.now();
// Embedded OpenCode: the SDK imports more bare node builtins (net, http, child_process, …) on paths the workerd
// profile never runs; keep them external like `celld deploy`'s own bundler does (BARE_NODE_BUILTINS). pkce-challenge
// (MCP client OAuth, unused: oauth is off) only has browser/node exports, and `debug` (proxy agents) calls
// tty.isatty at load in its node build: take their browser builds, as celld's bundler (platform=browser) would.
const aliased = ["async_hooks", "crypto", "buffer", "events", "util", "stream", "path", "fs", "os"];
const bareBuiltins = builtinModules.filter((m) => !m.startsWith("_") && !aliased.includes(m));
const nodeUrlShim = join(root, "src/agent/node-url.js");
const celldCompat = {
  name: "celld-compat",
  setup(b) {
    b.onResolve({ filter: /^(pkce-challenge|debug)$/ }, (args) => ({
      path: join(dirname(createRequire(args.importer).resolve(args.path)), args.path === "debug" ? "browser.js" : "index.browser.js"),
    }));
    // node:url without pathToFileURL/fileURLToPath in celld: the SDK imports them by name (src/agent/node-url.js).
    b.onResolve({ filter: /^(node:)?url$/ }, (args) =>
      args.importer === nodeUrlShim ? { path: "node:url", external: true } : { path: nodeUrlShim });
  },
};
await build({
  entryPoints: [entry],
  outfile: join(out, "worker.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  conditions: ["workerd", "worker", "import"],
  mainFields: ["module", "main"],
  external: ["cloudflare:*", "node:*", ...bareBuiltins],
  plugins: [celldCompat, nativeEffectContinuations],
  loader: { ".sql": "text" },
  // Better Auth / deps import bare node builtins in a few places: map them to node: (celld has nodejs_compat).
  alias: Object.fromEntries(aliased.map((m) => [m, `node:${m}`])),
  logLevel: "warning",
  legalComments: "none",
  minify,
  keepNames: minify,
});

// Static web bundle.
rmSync(join(out, "web"), { recursive: true, force: true });
if (!existsSync(webDir)) throw new Error(`BASKULE_WEB_DIR not found: ${webDir}`);
cpSync(webDir, join(out, "web"), { recursive: true });

// Downloads: copied under web/downloads with a manifest the Worker lists at /api/baskule/downloads and /downloads/.
const dlOut = join(out, "web", "downloads");
mkdirSync(dlOut, { recursive: true });
const files = [];
if (dlDir && existsSync(dlDir)) {
  for (const name of readdirSync(dlDir).sort()) {
    const p = join(dlDir, name);
    const st = statSync(p);
    if (!st.isFile() || name.startsWith(".") || name === "index.json") continue;
    cpSync(p, join(dlOut, name));
    files.push({ name, size: st.size, sha256: createHash("sha256").update(readFileSync(p)).digest("hex"), modified: st.mtime.toISOString() });
  }
}
writeFileSync(join(dlOut, "index.json"), JSON.stringify({ files }, null, 2));
console.error(`built ${out}/worker.js${minify ? " (minified)" : ""} + web (${webDir}) + ${files.length} download(s) in ${Date.now() - t0} ms`);
