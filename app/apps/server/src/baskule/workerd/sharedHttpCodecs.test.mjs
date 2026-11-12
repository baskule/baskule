import { expect, test } from "vite-plus/test";
import { build } from "esbuild";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { sharedHttpCodecs } from "./sharedHttpCodecs.mjs";

test("shared codecs preserve validation and keep service contexts separate", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hosted-http-codecs-"));
  try {
    const outfile = NodePath.join(dir, "fixture.mjs");
    await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
class Owner extends Context.Service()("test/Owner") {}
const endpoint = HttpApiEndpoint.post("echo", "/echo", { payload: Schema.Struct({ value: Schema.Number }), success: Schema.Struct({ owner: Schema.String, value: Schema.Number }) });
const api = HttpApi.make("test").add(HttpApiGroup.make("echo").add(endpoint));
const group = HttpApiBuilder.group(api, "echo", handlers => handlers.handle("echo", ({ payload }) => Effect.map(Owner, owner => ({ owner, value: payload.value }))));
export async function run() {
  globalThis.__fixtureCodecBuilds = 0;
  const create = owner => HttpRouter.toWebHandler(HttpApiBuilder.layer(api).pipe(Layer.provide(group), Layer.provide(Layer.succeed(Owner, owner)), Layer.provide(HttpServer.layerServices)), { disableLogger: true });
  const a = create("space-a"), b = create("space-b");
  try {
    const results = [];
    for (const [app, value] of [[a, 1], [b, 2], [a, "invalid"], [b, 3]]) {
      const response = await app.handler(new Request("http://space/echo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) }));
      const text = await response.text();
      results.push({ status: response.status, body: text ? JSON.parse(text) : null });
    }
    return { results, builds: globalThis.__fixtureCodecBuilds };
  } finally { await a.dispose(); await b.dispose(); }
}`,
      },
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      plugins: [
        {
          name: "observe-codec-factory",
          setup(build) {
            sharedHttpCodecs.setup({
              ...build,
              onLoad(options, load) {
                build.onLoad(options, async (args) => {
                  const result = await load(args);
                  if (!result) return result;
                  return {
                    ...result,
                    contents: result.contents.replace(
                      "  if (modes.has(isRaw)) return modes.get(isRaw);",
                      "  if (modes.has(isRaw)) return modes.get(isRaw);\n  globalThis.__fixtureCodecBuilds++;",
                    ),
                  };
                });
              },
            });
          },
        },
      ],
    });
    const { run } = await import(NodeURL.pathToFileURL(outfile).href);
    const { results, builds } = await run();
    expect(builds).toBe(1);
    expect(results[0]).toEqual({ status: 200, body: { owner: "space-a", value: 1 } });
    expect(results[1]).toEqual({ status: 200, body: { owner: "space-b", value: 2 } });
    expect(results[2].status).toBe(400);
    expect(results[3]).toEqual({ status: 200, body: { owner: "space-b", value: 3 } });
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

test("refuses a bundle that skips the Effect HTTP builder", async () => {
  await expect(
    build({
      stdin: { contents: "export const unrelated = 1" },
      bundle: true,
      write: false,
      plugins: [sharedHttpCodecs],
    }),
  ).rejects.toThrow(/did not rewrite HttpApiBuilder.js/);
});

test("refuses a newly captured factory variable at build time", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hosted-codec-anchor-"));
  try {
    const target = NodePath.join(dir, "effect/dist/http-api/HttpApiBuilder.js");
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    const source = await NodeFSP.readFile(
      NodePath.join(process.cwd(), "node_modules/effect/dist/http-api/HttpApiBuilder.js"),
      "utf8",
    );
    await NodeFSP.writeFile(
      target,
      source.replace(
        "  const payloadBy =",
        "  const decodeCookies = endpoint.cookies;\n  const payloadBy =",
      ),
    );
    await expect(
      build({ entryPoints: [target], bundle: true, write: false, plugins: [sharedHttpCodecs] }),
    ).rejects.toThrow(/factory body: declarations or captured dependencies changed/);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
