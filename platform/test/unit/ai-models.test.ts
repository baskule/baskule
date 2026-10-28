import { describe, expect, it, vi } from "vitest";
import { AIModels } from "../../src/control/ai-models";
import { BASKULE_AI_PROVIDERS } from "../../../app/packages/contracts/src/baskule";

const offlineCatalog = (url: string) => url === "https://models.dev/api.json" ? Promise.reject(new Error("offline")) : undefined;

/** Answers provider calls from `routes` by "METHOD url"; models.dev is offline. */
function provider(routes: Record<string, () => Response>) {
  const seen: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  const stub = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const catalog = offlineCatalog(url);
    if (catalog) return catalog;
    const method = init?.method ?? "GET";
    seen.push({ method, url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${url}`];
    if (!route) throw new TypeError("fetch failed");
    return route();
  });
  return { seen, [Symbol.dispose]: () => stub.mockRestore() };
}

describe("AI connection checks", () => {
  it("lists a vendor's chat models with preset and provider limits, presets first", async () => {
    using api = provider({
      "GET https://api.mistral.ai/v1/models": () => Response.json({ data: [
        { id: "zeta-chat", max_context_length: 64_000, capabilities: { completion_chat: true } },
        { id: "mistral-embed", capabilities: { completion_chat: false } },
        { id: "mistral-large-4", capabilities: { completion_chat: true } },
        { id: "zeta-chat" },
      ] }),
    });
    const models = await new AIModels().available({ providerId: "mistral", baseUrl: "https://api.mistral.ai/v1/", key: "mistral-key" });
    const preset = BASKULE_AI_PROVIDERS.mistral.models[0]!;
    expect(models).toEqual([
      { id: preset.id, name: preset.name, limit: preset.limit, cost: preset.cost },
      { id: "zeta-chat", name: "zeta-chat" },
    ]);
    expect(api.seen[0]?.headers.authorization).toBe("Bearer mistral-key");
  });

  it("reads Anthropic's names and limits with its own authentication headers", async () => {
    using api = provider({
      "GET https://api.anthropic.com/v1/models?limit=1000": () => Response.json({ data: [
        { id: "claude-new", display_name: "Claude New", max_input_tokens: 400_000, max_tokens: 64_000 },
      ] }),
    });
    expect(await new AIModels().available({ providerId: "anthropic", baseUrl: "https://api.anthropic.com/v1", key: "anthropic-key" }))
      .toEqual([{ id: "claude-new", name: "Claude New", limit: { context: 400_000, output: 64_000 } }]);
    expect(api.seen[0]?.headers).toMatchObject({ "x-api-key": "anthropic-key", "anthropic-version": "2023-06-01" });
    expect(api.seen[0]?.headers).not.toHaveProperty("authorization");
  });

  it("verifies vendor models by lookup and custom endpoints with one short completion", async () => {
    using api = provider({
      "GET https://api.openai.com/v1/models/gpt-6.1-sol": () => Response.json({ id: "gpt-6.1-sol" }),
      "POST https://llm.example.test/v1/chat/completions": () => Response.json({ choices: [{ message: { content: "Hello" } }] }),
    });
    const models = new AIModels();
    await models.verify({ providerId: "openai", baseUrl: "https://api.openai.com/v1", key: "openai-key" }, "gpt-6.1-sol");
    await models.verify({ providerId: "custom", baseUrl: "https://llm.example.test/v1", key: "" }, "local-model");
    expect(api.seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET https://api.openai.com/v1/models/gpt-6.1-sol",
      "POST https://llm.example.test/v1/chat/completions",
    ]);
    expect(api.seen[1]?.body).toMatchObject({ model: "local-model", max_tokens: 16 });
    expect(api.seen[1]?.headers).not.toHaveProperty("authorization");
  });

  it("names why a connection fails without repeating what the provider says about the key", async () => {
    using _api = provider({
      "GET https://api.openai.com/v1/models/gpt-6.1-sol": () => Response.json({ error: { message: "Incorrect API key provided: sk-pr***et" } }, { status: 401 }),
      "GET https://api.mistral.ai/v1/models/missing": () => Response.json({ message: "Model not found" }, { status: 404 }),
      "POST https://llm.example.test/v1/chat/completions": () => new Response("<html>proxy</html>", { status: 200 }),
      "POST https://quote.example.test/v1/chat/completions": () => Response.json({ error: { message: "Rejected key: custom-secret" } }, { status: 400 }),
      "POST https://long.example.test/v1/chat/completions": () => Response.json({ error: { message: `${"x".repeat(290)} custom-secret` } }, { status: 400 }),
    });
    const models = new AIModels();
    const failure = (promise: Promise<unknown>) => promise.then(() => null, (error) => ({ status: error.status, code: error.code, message: error.message }));
    expect(await failure(models.verify({ providerId: "openai", baseUrl: "https://api.openai.com/v1", key: "sk-private-secret" }, "gpt-6.1-sol")))
      .toEqual({ status: 400, code: "ai_key_rejected", message: "The provider rejected the API key" });
    expect(await failure(models.verify({ providerId: "mistral", baseUrl: "https://api.mistral.ai/v1", key: "k" }, "missing")))
      .toEqual({ status: 400, code: "ai_model_not_found", message: "Model not found" });
    expect(await failure(models.verify({ providerId: "mistral", baseUrl: "https://api.mistral.ai/v1", key: "" }, "missing")))
      .toMatchObject({ status: 400, code: "ai_key_missing" });
    expect(await failure(models.verify({ providerId: "custom", baseUrl: "https://llm.example.test/v1", key: "" }, "m")))
      .toMatchObject({ status: 502, code: "ai_provider_error" });
    expect(await failure(models.verify({ providerId: "custom", baseUrl: "https://quote.example.test/v1", key: "custom-secret" }, "m")))
      .toEqual({ status: 502, code: "ai_provider_error", message: "The provider answered HTTP 400: Rejected key: •••" });
    expect((await failure(models.verify({ providerId: "custom", baseUrl: "https://long.example.test/v1", key: "custom-secret" }, "m")))?.message)
      .not.toContain("custom-s");
    expect(await failure(models.available({ providerId: "openai", baseUrl: "https://down.example.test/v1", key: "k" })))
      .toEqual({ status: 502, code: "ai_provider_unreachable", message: "Could not reach down.example.test" });
  });

  it("prices built-in models from presets, then the catalog, and never custom ones", async () => {
    using _api = provider({});
    const models = new AIModels();
    const preset = BASKULE_AI_PROVIDERS.anthropic.models[0]!;
    expect(await models.price("anthropic", preset.id)).toEqual(preset.cost);
    expect(await models.price("openai", "not-in-any-catalog")).toBeUndefined();
    expect(await models.price("custom", "gpt-6.1-sol")).toBeUndefined();
  });
});
