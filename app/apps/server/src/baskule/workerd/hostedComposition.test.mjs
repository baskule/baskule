import { expect, test } from "vite-plus/test";
import { build } from "esbuild";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { hostedComposition } from "./hostedComposition.mjs";

test("the hosted OAuth signer retries a transient first secret failure", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hosted-oauth-"));
  try {
    const outfile = NodePath.join(dir, "fixture.mjs");
    await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
import "./src/server.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as OAuth from "./src/auth/McpOAuth.ts";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Auth from "./src/auth/EnvironmentAuth.ts";
import * as Policy from "./src/policy/ManagedPolicy.ts";
import * as Secrets from "./src/auth/ServerSecretStore.ts";
export const run = () => Effect.runPromise(Effect.gen(function* () {
  let attempts = 0;
  const dependencies = Layer.mergeAll(NodeCrypto.layer, Policy.layerTest(), Layer.mock(Auth.EnvironmentAuth)({ authenticateHttpRequest: request => Effect.succeed({ sessionId: "cookie-session", method: request.headers["x-fixture-method"] ?? "browser-session-cookie", scopes: ["access:write", "orchestration:read"] }) }), Layer.mock(Secrets.ServerSecretStore)({
    getOrCreateRandom: () => Effect.suspend(() => ++attempts === 1 ? Effect.die("transient secret read") : Effect.succeed(new Uint8Array(32).fill(7))),
  }));
  return yield* Effect.gen(function* () {
    const oauth = yield* OAuth.McpOAuth;
    const eagerAttempts = attempts;
    const input = { client_name: "fixture", redirect_uris: ["http://localhost/callback"] };
    const failed = Exit.isFailure(yield* Effect.exit(oauth.register(input)));
    const first = yield* oauth.register(input);
    const second = yield* oauth.register(input);
    const authorization = { client: first, redirectUri: "http://localhost/callback", codeChallenge: "challenge", state: undefined, resource: "http://space/mcp", issuer: "http://space" };
    const request = headers => HttpServerRequest.fromWeb(new Request("http://space/oauth/mcp/authorize", { headers }));
    const cookie = yield* oauth.approvingSession(request({}), authorization);
    const tokenCookie = yield* oauth.approvingSession(request({ "x-fixture-method": "bearer-access-token" }), authorization);
    const bearer = yield* oauth.approvingSession(request({ authorization: "Bearer fixture" }), authorization);
    return { eagerAttempts, failed, attempts, same: first.clientId === second.clientId, signed: first.clientId.includes("."), cookieApproves: typeof cookie?.csrfToken === "string", tokenCookieRefused: tokenCookie === undefined, bearerRefused: bearer === undefined };
  }).pipe(Effect.provide(OAuth.layer.pipe(Layer.provide(dependencies))));
}));`,
      },
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      loader: {
        ".node": "empty",
        ".html": "text",
        ".md": "text",
        ".svg": "text",
        ".wasm": "binary",
      },
      logOverride: { "import-is-undefined": "error" },
      plugins: [hostedComposition],
    });
    const { run } = await import(NodeURL.pathToFileURL(outfile).href);
    expect(await run()).toEqual({
      eagerAttempts: 0,
      failed: true,
      attempts: 2,
      same: true,
      signed: true,
      cookieApproves: true,
      tokenCookieRefused: true,
      bearerRefused: true,
    });
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

test("refuses a bundle that skips expected hosted targets", async () => {
  await expect(
    build({
      stdin: { contents: "export const unrelated = 1" },
      bundle: true,
      write: false,
      plugins: [hostedComposition],
    }),
  ).rejects.toThrow(
    /did not rewrite:.*server.ts.*ServerEnvironment.ts.*ServerEnvironmentLabel.ts.*McpOAuth.ts/,
  );
});

test("refuses a changed full SpeechModelStore layer expression", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hosted-anchor-"));
  try {
    const target = NodePath.join(dir, "apps/server/src/server.ts");
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    const source = await NodeFSP.readFile(new URL("../../server.ts", import.meta.url), "utf8");
    await NodeFSP.writeFile(
      target,
      source.replace(
        "Layer.provide(SpeechModelStore.layer)",
        "Layer.provide(SpeechModelStore.layerLive)",
      ),
    );
    await expect(
      build({ entryPoints: [target], bundle: true, write: false, plugins: [hostedComposition] }),
    ).rejects.toThrow(/anchor changed: Layer.provide\(SpeechModelStore.layer\)/);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

test("the hosted warning policy refuses an undefined namespace export", async () => {
  await expect(
    build({
      stdin: {
        resolveDir: process.cwd(),
        contents:
          'import * as Trims from "./src/baskule/workerd/hostedTrims.ts"; console.log(Trims.layerSpeechModelStoreLive);',
      },
      bundle: true,
      write: false,
      platform: "node",
      logOverride: { "import-is-undefined": "error" },
    }),
  ).rejects.toThrow(/layerSpeechModelStoreLive/);
});
