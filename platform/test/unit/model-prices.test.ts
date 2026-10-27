import { describe, expect, it, vi } from "vitest";
import { ModelPrices } from "../../src/control/model-prices";
import snapshot from "../../src/control/data/model-prices.json";

describe("model price suggestions", () => {
  it("uses USD per million tokens from the live catalog and caches it", async () => {
    using stub = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ mistral: { models: { example: { cost: { input: 2, output: 8, cache_read: 0.2 } } } }, openai: { models: {} }, anthropic: { models: {} } }));
    const prices = new ModelPrices();
    expect(await prices.suggest("mistral", "example")).toMatchObject({ source: "models.dev", prices: { input: 2, output: 8, cacheRead: 0.2 } });
    await prices.suggest("mistral", "example");
    expect(stub).toHaveBeenCalledTimes(1);
  });
  it("uses the generated snapshot on fetch failure and rejects unsupported providers", async () => {
    using _fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const prices = new ModelPrices();
    const model = Object.keys(snapshot.providers.openai)[0];
    expect(await prices.suggest("openai", model)).toMatchObject({ source: "snapshot", fetchedAt: snapshot.fetchedAt, prices: { input: snapshot.providers.openai[model as keyof typeof snapshot.providers.openai].input } });
    await expect(prices.suggest("custom", model)).rejects.toThrow();
    await expect(prices.suggest("openai", "nonexistent-model")).rejects.toThrow();
  });
});
