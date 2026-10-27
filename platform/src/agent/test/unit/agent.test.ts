// Unit tests of the embedded agent's pure parts (no celld, no computer): session interception, OpenCode config and the
// remote spawner over a fake computerd.
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { computerPath, type Models, offeredModel, prepareSessionCreate, stripNulls } from "../../session";
import { defaultSettings, parseSettings } from "../../../control/settings";
import { BASKULE_AI_PROVIDERS } from "../../../../../app/packages/contracts/src/baskule";
import { configModels, configPrices, opencodeConfig, TEST_PATCH_MODEL } from "../../config";
import { makeRemoteSpawner } from "../../remote-spawner.js";

const ndjson = (frames: object[]) =>
  new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(JSON.stringify(f) + "\n")); c.close(); } }));
const b64 = (s: string) => Buffer.from(s).toString("base64");
const models: Models = { offered: new Set(["mistral/m1", "mistral/gpt-fake-patch"]), fallback: { providerID: "mistral", id: "m1" } };

describe("session create interception", () => {
  it("strips nulls recursively", () => {
    expect(stripNulls({ a: null, b: { c: null, d: 1 }, e: [null, { f: null, g: 2 }] })).toEqual({ b: { d: 1 }, e: [{ g: 2 }] });
  });
  it("binds the session to the computer workspace and keeps the directory", () => {
    const p = prepareSessionCreate({ title: "x", location: { directory: "/sandbox/space/chats/a", workspaceID: null }, model: null, permissions: [{ action: "*", resource: "*", effect: "allow" }] }, "wrk_1", "/sandbox/space", models);
    expect(p).toMatchObject({ directory: "/sandbox/space/chats/a", input: { title: "x", location: { directory: "/sandbox/space/chats/a", workspaceID: "wrk_1" } } });
    const input = (p as unknown as { input: { permissions: { action: string; effect: string }[]; model?: unknown } }).input;
    expect(input.model).toBeUndefined();
    expect(input.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
  });
  it("defaults the directory and refuses paths outside /sandbox", () => {
    expect(prepareSessionCreate({}, "w", "/sandbox/space", models)).toMatchObject({ directory: "/sandbox/space" });
    expect(prepareSessionCreate({ location: { directory: "/etc" } }, "w", "/sandbox/space", models)).toHaveProperty("error");
    expect(prepareSessionCreate({ location: { directory: "/sandbox/../etc" } }, "w", "/sandbox/space", models)).toHaveProperty("error");
    expect(prepareSessionCreate({ location: { directory: "relative" } }, "w", "/sandbox/space", models)).toHaveProperty("error");
    expect(prepareSessionCreate([], "w", "/sandbox/space", models)).toHaveProperty("error");
  });
  it("lets a child session inherit its parent's location", () => {
    const p = prepareSessionCreate({ parentID: "ses_1", location: { directory: "/elsewhere" } }, "w", "/sandbox/space", models);
    expect(p).toEqual({ input: { parentID: "ses_1" }, directory: null });
  });
  it("runs a model the installation no longer offers on the installation's model", () => {
    expect(offeredModel({ providerID: "mistral", id: "gpt-fake-patch", variant: "x" }, models)).toEqual({ providerID: "mistral", id: "gpt-fake-patch", variant: "x" });
    expect(offeredModel({ providerID: "openai", id: "gpt-6-luna" }, models)).toEqual(models.fallback);
    expect(offeredModel({ providerID: "mistral", id: "retired" }, models)).toEqual(models.fallback);
    expect(offeredModel(undefined, models)).toEqual(models.fallback);
    const p = prepareSessionCreate({ model: { providerID: "mistral", id: "retired" } }, "w", "/sandbox/space", models);
    expect(p).toMatchObject({ input: { model: models.fallback } });
  });
  it("normalizes computer paths", () => {
    expect(computerPath("/sandbox//space/")).toBe("/sandbox/space");
    expect(computerPath("/sandboxx")).toBeNull();
    expect(computerPath("/sandbox/./x")).toBeNull();
  });
});

describe("OpenCode config", () => {
  const env = { AI: { providerId: "custom" as const, baseUrl: "http://llm/v1", apiKey: "test-secret", model: { id: "m1", name: "M1", image: true, pdf: false, limit: { context: 128_000, output: 8_000 }, settings: { reasoningEffort: "none" } } } };
  it("keeps the installation default and private key in env, image by default, pdf on demand", () => {
    const c = opencodeConfig(env, "runtime-key", "http://baskule-mcp.internal/s-decision/mcp") as any;
    expect(c.model).toBe("custom/m1");
    expect(c.default_agent).toBe("assistant");
    expect(c.providers.custom.env).toEqual(["runtime-key"]);
    expect(JSON.stringify(c.providers.custom.settings)).not.toMatch(/apiKey/i);
    expect(c.providers.custom.models.m1.limit).toEqual({ context: 128_000, output: 8_000 });
    expect(c.providers.custom.models.m1.settings).toEqual({ reasoningEffort: "none" });
    expect(c.providers.custom.models.m1.capabilities.input).toEqual(["text", "image"]);
    expect(Object.keys(c.providers.custom.models)).toEqual(["m1"]);
    expect(configPrices(c)["custom/m1"]).toEqual({ input: 0, output: 0 });
    const pdfConfig = opencodeConfig({ ...env, AI: { ...env.AI, model: { ...env.AI.model, pdf: true } } }, "runtime-key") as any;
    expect(pdfConfig.providers.custom.models.m1.capabilities.input).toEqual(["text", "image", "pdf"]);
    expect(JSON.stringify(c)).not.toContain("test-secret");
    expect(c.mcp.servers).toEqual({ decision: { type: "remote", url: "http://baskule-mcp.internal/s-decision/mcp", oauth: false, codemode: false } });
    expect(c.websearch).toEqual({ provider: "random" });
    expect(c.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "custom", effect: "allow" },
    ]);
    expect(c.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
    expect(c.agents.assistant.system).toMatch(/\/sandbox\/space\/chats/);
    expect(c.agents.build.system).toBe(c.agents.assistant.system);
  });
  it.each(["mistral", "openai", "anthropic"] as const)("uses %s native routing and model pricing without exposing a key", (providerId) => {
    const provider = BASKULE_AI_PROVIDERS[providerId];
    const model = { ...provider.models[0]!, settings: {} };
    const c = opencodeConfig({ AI: { ...defaultSettings.ai, providerId, model, apiKey: "private-key" } }, "runtime-key") as any;
    expect(Object.keys(c.providers)).toEqual([providerId]);
    expect(c.model).toBe(`${providerId}/${model.id}`);
    expect(c.providers[providerId].package).toBe(`@opencode/ai/providers/${providerId}`);
    expect(c.providers[providerId].models[model.id].cost).toEqual({ input: model.cost?.input, output: model.cost?.output,
      cache: { read: model.cost?.cache_read, write: model.cost?.cache_write } });
    expect(configPrices(c)[`${providerId}/${model.id}`]).toEqual({ input: model.cost?.input, output: model.cost?.output,
      cacheRead: model.cost?.cache_read, cacheWrite: model.cost?.cache_write });
    expect(c.policies).toContainEqual({ action: "provider.use", resource: providerId, effect: "allow" });
    expect(JSON.stringify(c)).not.toContain("private-key");
  });
  it("uses only the installation provider and enables cell tools", () => {
    const c = opencodeConfig(env, "runtime-key") as any;
    expect(Object.keys(c.providers)).toEqual(["custom"]);
    expect(c.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "custom", effect: "allow" },
    ]);
    expect(c.permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
    ]);
    const offered = configModels(c);
    const deepseek = { providerID: "opencode", id: "deepseek-v4.1-flash-free" };
    expect(offered).toEqual({ offered: new Set(["custom/m1"]), fallback: { providerID: "custom", id: "m1" } });
    expect(offeredModel(deepseek, offered)).toEqual(offered.fallback);
    expect(prepareSessionCreate({ model: deepseek }, "w", "/sandbox/space", offered)).toMatchObject({ input: { model: offered.fallback } });
    expect(offeredModel({ providerID: "opencode", id: "deepseek-v4.1-flash" }, offered)).toEqual(offered.fallback);
    expect(offeredModel({ providerID: "opencode", id: "big-pickle" }, offered)).toEqual(offered.fallback);
  });
  it("uses public auth without private environment keys for a keyless installation", () => {
    const provider = BASKULE_AI_PROVIDERS.opencode;
    const ai = parseSettings({ ...defaultSettings, ai: { providerId: "opencode", baseUrl: provider.baseUrl, model: provider.models[0] } }).ai;
    const model = ai.model;
    const c = opencodeConfig({ AI: { ...ai, apiKey: "ignored-private-key" } }, "private-env-key") as any;
    expect(Object.keys(c.providers)).toEqual(["opencode"]);
    expect(c.model).toBe(`opencode/${model.id}`);
    expect(c.providers.opencode).toMatchObject({
      package: provider.package, env: [], settings: { baseURL: provider.baseUrl, apiKey: "public" },
    });
    expect(c.providers.opencode.models[model.id].settings).toEqual(model.settings);
    expect(configModels(c)).toEqual({ offered: new Set([`opencode/${model.id}`]), fallback: { providerID: "opencode", id: model.id } });
    expect(configPrices(c)[`opencode/${model.id}`]).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(c.policies.filter((p: { action: string }) => p.action === "provider.use")).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "opencode", effect: "allow" },
    ]);
    expect(JSON.stringify(c)).not.toMatch(/ignored-private-key|private-env-key/);
  });
  it("adds the patch test model only in debug mode", () => {
    const c = opencodeConfig({ ...env, BASKULE_AGENT_DEBUG: "1" }, "runtime-key") as any;
    expect(Object.keys(c.providers.custom.models)).toEqual(["m1", TEST_PATCH_MODEL]);
    expect(configModels(c)).toEqual({ offered: new Set(["custom/m1", `custom/${TEST_PATCH_MODEL}`]), fallback: { providerID: "custom", id: "m1" } });
    expect(c.mcp.servers).toEqual({});
  });
});

describe("remote spawner", () => {
  const run = <A>(eff: Effect.Effect<A, unknown, any>) => Effect.runPromise(Effect.scoped(eff) as Effect.Effect<A>);
  it("runs argv on the computer with cwd, env and collected stdin; streams output and exit code", async () => {
    const calls: any[] = [];
    const spawner = makeRemoteSpawner({
      exec: async (spec) => {
        calls.push(spec);
        return ndjson([{ t: "o", d: b64("hello ") }, { t: "e", d: b64("warn") }, { t: "o", d: b64("world") }, { t: "x", code: 3 }]);
      },
      kill: async () => ({}),
    });
    const out = await run(Effect.gen(function* () {
      const h = yield* spawner.spawn(ChildProcess.make("sh", ["-c", "cat > f"], { cwd: "/sandbox/space/chats/a", env: { LC_ALL: "C", X: undefined as never }, stdin: Stream.make(new TextEncoder().encode("ab"), new TextEncoder().encode("c")) }));
      const [o, e, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(h.stdout)), Stream.mkString(Stream.decodeText(h.stderr)), h.exitCode], { concurrency: "unbounded" });
      return { o, e, code };
    }));
    expect(out).toEqual({ o: "hello world", e: "warn", code: 3 });
    expect(calls[0]).toMatchObject({ argv: ["sh", "-c", "cat > f"], cwd: "/sandbox/space/chats/a", env: { LC_ALL: "C" }, stdin: b64("abc") });
    expect(calls[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("fails the exit code on a transport error frame", async () => {
    const spawner = makeRemoteSpawner({ exec: async () => ndjson([{ t: "err", msg: "gateway down" }]), kill: async () => ({}) });
    const r = await run(Effect.gen(function* () {
      const h = yield* spawner.spawn(ChildProcess.make("true", []));
      return yield* Effect.exit(h.exitCode);
    }));
    expect(r._tag).toBe("Failure");
    expect(JSON.stringify(r)).toMatch(/gateway down/);
  });
  it("kills the remote process when the scope closes before the exit (abort)", async () => {
    const kills: any[] = [];
    let aborted = false;
    const spawner = makeRemoteSpawner({
      exec: async (_spec, signal) => {
        signal.addEventListener("abort", () => (aborted = true));
        return new Response(new ReadableStream({ start() {} })); // never exits
      },
      kill: async (id, sig, grace) => { kills.push({ id, sig, grace }); return {}; },
    });
    await run(Effect.gen(function* () { yield* spawner.spawn(ChildProcess.make("sleep", ["100"])); }));
    expect(kills).toEqual([{ id: expect.any(String), sig: "KILL", grace: 0 }]);
    expect(aborted).toBe(true);
  });
  it("handle.kill sends TERM with the grace period", async () => {
    const kills: any[] = [];
    let finish!: () => void;
    const spawner = makeRemoteSpawner({
      exec: async () => new Response(new ReadableStream({ start(c) { finish = () => { c.enqueue(new TextEncoder().encode('{"t":"x","code":15}\n')); c.close(); }; } })),
      kill: async (id, sig, grace) => { kills.push({ sig, grace }); finish(); return {}; },
    });
    const code = await run(Effect.gen(function* () {
      const h = yield* spawner.spawn(ChildProcess.make("sleep", ["100"]));
      yield* h.kill();
      return yield* h.exitCode;
    }));
    expect(kills).toEqual([{ sig: "TERM", grace: 3000 }]);
    expect(code).toBe(15);
  });
  it("reports a computerd refusal as a spawn error", async () => {
    const spawner = makeRemoteSpawner({ exec: async () => new Response('{"error":"too many"}', { status: 429 }), kill: async () => ({}) });
    const r = await run(Effect.exit(spawner.spawn(ChildProcess.make("ls", []))));
    expect(JSON.stringify(r)).toMatch(/429/);
  });
});
