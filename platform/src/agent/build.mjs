import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BASKULE_AI_PROVIDERS } from "../../../app/packages/contracts/src/baskule.ts";

const integration = fileURLToPath(new URL("./opencode.js", import.meta.url));
const providerPackages = new Set(Object.values(BASKULE_AI_PROVIDERS).map(provider => provider.package));
const registry = /var builtins = new Map\(\[([\s\S]*?)\n\]\);/g;
const providerImport = /\(\) => import\("(@opencode\/ai\/providers\/[^"\n]+)"\)/g;
const catalog = /\/\/ src\/models-dev\/snapshot\.txt\nvar snapshot_default = [^\n]+;\n/g;

// Exclude the disabled model catalog and adapters outside the installation provider configuration.
export const embeddedAgent = {
  name: "baskule-embedded-agent",
  setup(build) {
    let integrationUsed = false;
    let catalogFound = false;
    let providersFound = false;
    let shellCleanupFound = false;
    build.onStart(async () => {
      integrationUsed = false;
      catalogFound = false;
      providersFound = false;
      shellCleanupFound = false;
      const source = await readFile(integration, "utf8");
      if (!source.includes("models: { fetch: false, snapshot: false }")) {
        throw new Error("Embedded OpenCode must disable the model catalog before excluding its bundled snapshot.");
      }
    });
    build.onLoad({ filter: /[/\\]agent[/\\]opencode\.js$/ }, ({ path }) => {
      if (path === integration) integrationUsed = true;
    });
    build.onEnd(() => {
      if (integrationUsed && (!catalogFound || !providersFound || !shellCleanupFound)) {
        throw new Error("Embedded OpenCode catalog, provider registry, or Shell finalizer was not found; check the pinned SDK layout.");
      }
    });
    build.onLoad({ filter: /[/\\]@opencode[/\\]codemode[/\\]dist[/\\]interpreter[/\\]runner\.js$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      const before = `                if (start === undefined) {
                    const job = self.dequeue();`;
      const inbox = `                    const settle = self.inbox.shift();
                    if (settle !== undefined) {
                        settle();
                        continue;
                    }
`;
      if (source.split(before).length !== 2 || source.split(inbox).length !== 2)
        throw new Error(`OpenCode Code Mode runner layout changed: ${path}`);
      // 2.2.5's queued await-null jobs otherwise starve completed host tools forever.
      return { contents: source.replace(inbox, "").replace(before,
        `                if (start === undefined) {\n${inbox}                    const job = self.dequeue();`), loader: "js" };
    });
    build.onLoad({ filter: /[/\\]@opencode[/\\]core[/\\]dist[/\\]chunks[/\\][^/\\]+\.js$/ }, async ({ path }) => {
      let source = await readFile(path, "utf8");
      let captureCleanup = false;
      if (source.includes("  const commands = new Map;\n  const exitOrder = [];")) {
        const finalizer = "    commands.clear();\n    exitOrder.length = 0;";
        if (source.split(finalizer).length !== 2) throw new Error(`OpenCode Shell finalizer layout changed: ${path}`);
        source = source.replace(finalizer, "    yield* Effect.promise(() => Promise.all([...commands.values()].map(command => unlink(command.file).catch(() => {}))));\n" + finalizer);
        captureCleanup = true;
        shellCleanupFound = true;
      }
      const hasRegistry = source.includes("var builtins = new Map([");
      if (hasRegistry) {
        const maps = [...source.matchAll(registry)];
        if (maps.length !== 1) throw new Error(`OpenCode provider registry layout changed: ${path}`);
        const entries = maps[0][1];
        const loaders = [...entries.matchAll(providerImport)].map(match => match[1]);
        if (loaders.length !== [...entries.matchAll(/\[\s*"[^"\n]+"\s*,/g)].length) {
          throw new Error(`OpenCode provider loader layout changed: ${path}`);
        }
        for (const pkg of providerPackages) {
          if (!loaders.includes(pkg)) throw new Error(`Baskule provider package is absent from the SDK registry: ${pkg}`);
        }
        source = source.replace(registry, (_, entries) => `var builtins = new Map([${entries.replace(providerImport, (loader, pkg) =>
          [...providerPackages].some(allowed => pkg === allowed || pkg.startsWith(`${allowed}/`))
            ? loader
            : `() => Promise.reject(new Error(${JSON.stringify("Provider package " + pkg + " is unavailable in Baskule")}))`
        )}\n]);`);
        providersFound = true;
      }
      if (!source.includes("// src/models-dev/snapshot.txt")) {
        if (hasRegistry || captureCleanup) return { contents: source, loader: "js" };
        return;
      }
      const matches = [...source.matchAll(catalog)];
      if (matches.length !== 1) throw new Error(`OpenCode model catalog layout changed: ${path}`);
      catalogFound = true;
      return { contents: source.replace(catalog, 'var snapshot_default = "{}";\n'), loader: "js" };
    });
  },
};
