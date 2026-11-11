#!/usr/bin/env node
// Builds native celld workers: dist/runtime/index.js, dist/web-worker/index.js, and dist/web assets.
//   BASKULE_WEB_DIR        directory of the web build to serve (default: web-placeholder/)
//   BASKULE_ENTRY          Worker entry (default: src/worker.ts; the integration test uses its own)
//   BASKULE_OUT            output dir (default: dist)
//   BASKULE_MINIFY=1       minify the Worker, keeping function and class names (production: deploy/build.sh)
//   BASKULE_METAFILE       optional esbuild dependency report path (outside the deployed runtime directory)
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules, createRequire } from "node:module";
import { createHash } from "node:crypto";
import { nativeEffectContinuations } from "../../app/apps/server/src/baskule/workerd/nativeEffectContinuations.mjs";
import { embeddedAgent } from "../src/agent/build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, process.env.BASKULE_OUT ?? "dist");
const entry = resolve(root, process.env.BASKULE_ENTRY ?? "src/worker.ts");
const webDir = resolve(root, process.env.BASKULE_WEB_DIR ?? "web-placeholder");
// Names are kept so stack traces in celld remain readable. Each worker is one self-contained ESM file.
const minify = process.env.BASKULE_MINIFY === "1";

mkdirSync(out, { recursive: true });
const runtime = join(out, "runtime");
const webWorker = join(out, "web-worker");
rmSync(runtime, { recursive: true, force: true });
rmSync(webWorker, { recursive: true, force: true });
rmSync(join(out, "worker.js"), { force: true });
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
const result = await build({
  entryPoints: { index: entry },
  outdir: runtime,
  metafile: Boolean(process.env.BASKULE_METAFILE),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  conditions: ["workerd", "worker", "import"],
  mainFields: ["module", "main"],
  external: ["cloudflare:*", "node:*", ...bareBuiltins],
  plugins: [embeddedAgent, celldCompat, nativeEffectContinuations],
  loader: { ".sql": "text" },
  // Better Auth / deps import bare node builtins in a few places: map them to node: (celld has nodejs_compat).
  alias: Object.fromEntries(aliased.map((m) => [m, `node:${m}`])),
  logLevel: "warning",
  legalComments: "none",
  minify,
  keepNames: minify,
  // no_bundle skips celld's esbuild pass, including its lexical bridge for
  // CommonJS dependencies that require node builtins. Keep the same boundary.
  banner: { js: `var require = (id) => {
  const name = String(id);
  const builtin = process.getBuiltinModule(name);
  if (builtin === undefined) {
    const error = new Error(\`Cannot find module '\${name}'\`);
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return builtin;
};` },
});
if (process.env.BASKULE_METAFILE) writeFileSync(process.env.BASKULE_METAFILE, JSON.stringify(result.metafile));

// celld captures service versions in the frontend's deployment graph. Backend code changes must also change
// the frontend artifact, even when its routing source is unchanged. Deployment handles backend vars separately.
const backendHash = createHash("sha256").update(readFileSync(join(runtime, "index.js"))).digest("hex");
await build({
  entryPoints: { index: join(root, "src/web.ts") },
  outdir: webWorker,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  logLevel: "warning",
  legalComments: "none",
  minify,
  keepNames: minify,
  banner: { js: `// Baskule backend artifact sha256: ${backendHash}` },
});

// Static web bundle.
rmSync(join(out, "web"), { recursive: true, force: true });
if (!existsSync(webDir)) throw new Error(`BASKULE_WEB_DIR not found: ${webDir}`);
cpSync(webDir, join(out, "web"), { recursive: true });

const version = process.env.BASKULE_VERSION ?? readFileSync(join(root, "../VERSION"), "utf8").trim();
writeFileSync(join(out, "web", "version.json"), JSON.stringify({ version }));
console.error(`built ${runtime}/index.js + ${webWorker}/index.js${minify ? " (minified)" : ""} + web (${webDir}) in ${Date.now() - t0} ms`);
