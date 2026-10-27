// baskule: builds T3's server for workerd as one ESM file, `apps/server/dist-workerd/space-cell.js`,
// which the Baskule platform's SpaceCell imports (platform/src/space). Usage, from apps/server:
//   node src/baskule/workerd/build.mjs [--minify] [--out <file>]
// --minify (production, deploy/v2/build.sh): minified, function and class names kept for readable stack traces.
//
// Every substitution the workerd build needs is listed here, in one place:
// - node built-ins celld lacks or stubs are aliased to ./shims (module, os, process, net,
//   perf_hooks, sea, url) and proper-lockfile to a no-op lock;
// - host-bound modules a space never uses are replaced by stubs in ./trim (`TRIM` below): terminals, devices,
//   the local preview browser, source-control drivers (each stub's header says why it is safe);
// - other node built-ins stay external (`node:*`), served by celld's nodejs_compat.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { nativeEffectContinuations } from "./nativeEffectContinuations.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "../../..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outfile =
  outIndex === -1 ? join(serverRoot, "dist-workerd/space-cell.js") : resolve(args[outIndex + 1]);
const minify = args.includes("--minify");

const SHIMS = {
  module: "module.js",
  os: "os.js",
  process: "process.js",
  net: "net.js",
  perf_hooks: "perf_hooks.js",
  sea: "sea.js",
  url: "url.js",
};
// Host-bound modules replaced by a stub in ./trim (same exports and service keys, inert implementation): path of
// the real module, relative to apps/server → stub file in ./trim. Each stub's header says why it is safe.
const TRIM = {
  "src/terminal/Manager.ts": "TerminalManager.ts",
  "src/sourceControl/builtInDrivers.ts": "sourceControlDrivers.ts",
  "src/preview/ServerBrowser.ts": "ServerBrowser.ts",
  "src/device/DeviceService.ts": "DeviceService.ts",
  "src/device/DeviceHubProxy.ts": "DeviceHubProxy.ts",
};
const TRIMMED = new Map(
  Object.entries(TRIM).map(([real, stub]) => [resolve(serverRoot, real), join(here, "trim", stub)]),
);
const trimmedNames = [
  ...new Set([...TRIMMED.keys()].map((p) => basename(p).replace(/\W/g, "\\$&"))),
];
const TRIM_FILTER = new RegExp(`/(${trimmedNames.join("|")})$`);
const trimmedHits = new Set();
const NODE_BUILTIN =
  /^(node:[a-z0-9_/]+|(assert|async_hooks|buffer|child_process|cluster|constants|crypto|dgram|diagnostics_channel|dns|dns\/promises|events|fs|fs\/promises|http|http2|https|inspector|path|path\/posix|path\/win32|punycode|querystring|readline|stream|stream\/promises|stream\/web|string_decoder|timers|timers\/promises|tls|tty|util|util\/types|v8|vm|worker_threads|zlib))$/;

const substitutions = {
  name: "baskule-workerd",
  setup(build) {
    build.onResolve({ filter: /^(node:)?(module|os|process|net|perf_hooks|sea|url)$/ }, (a) => {
      const name = a.path.replace(/^node:/, "");
      return { path: join(here, "shims", SHIMS[name]) };
    });
    build.onResolve({ filter: /^proper-lockfile$/ }, () => ({
      path: join(here, "shims/lockfile.js"),
    }));
    // Stubs are swapped at load time, so every import of the real module (relative or through a package
    // export) gets the stub, and the stub's own imports resolve from ./trim.
    build.onLoad({ filter: TRIM_FILTER }, (a) => {
      const stub = TRIMMED.get(a.path);
      if (!stub) return undefined;
      trimmedHits.add(a.path);
      return { contents: readFileSync(stub, "utf8"), loader: "ts", resolveDir: dirname(stub) };
    });
    build.onResolve({ filter: NODE_BUILTIN }, (a) => ({
      path: a.path.startsWith("node:") ? a.path : `node:${a.path}`,
      external: true,
    }));
  },
};

const started = Date.now();
const result = await esbuild.build({
  entryPoints: [join(here, "index.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  conditions: ["workerd", "worker", "import", "module", "default"],
  mainFields: ["module", "main"],
  external: ["cloudflare:*"],
  loader: { ".node": "empty", ".html": "text", ".md": "text", ".svg": "text", ".wasm": "binary" },
  minify,
  keepNames: minify,
  metafile: true,
  logLevel: "error",
  plugins: [substitutions, nativeEffectContinuations],
  define: {
    "import.meta.dirname": '"/baskule/app"',
    "import.meta.filename": '"/baskule/app/space-cell.js"',
  },
});
// A trimmed module that was renamed or moved upstream would silently be bundled again: refuse.
const unused = [...TRIMMED.keys()].filter((path) => !trimmedHits.has(path));
if (unused.length > 0) {
  throw new Error(`trim entries matched no bundled module (moved upstream?): ${unused.join(", ")}`);
}
mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(`${outfile}.meta.json`, JSON.stringify(result.metafile));
const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(
  `space-cell bundle: ${outfile} (${(bytes / 2 ** 20).toFixed(1)} MiB, ${Date.now() - started} ms)`,
);
