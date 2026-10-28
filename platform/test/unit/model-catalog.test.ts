import { describe, expect, it, vi } from "vitest";
import { ModelCatalog } from "../../src/control/model-catalog";
import snapshot from "../../src/control/data/model-prices.json";

describe("model catalog", () => {
  it("reads prices and valid limits from models.dev and caches them", async () => {
    using stub = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      mistral: { models: { example: { name: "Example", cost: { input: 2, output: 8, cache_read: 0.2 }, limit: { context: 128_000, output: 8_000 } }, unpriced: { limit: { context: 0, output: 1 } } } },
      openai: { models: {} }, anthropic: { models: {} },
    }));
    const catalog = new ModelCatalog();
    expect(await catalog.models("mistral")).toEqual({
      example: { name: "Example", cost: { input: 2, output: 8, cache_read: 0.2 }, limit: { context: 128_000, output: 8_000 } },
      unpriced: {},
    });
    await catalog.models("openai");
    expect(stub).toHaveBeenCalledTimes(1);
  });
  it("falls back to the generated price snapshot, and does not retry at once", async () => {
    using stub = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const catalog = new ModelCatalog();
    const [id, cost] = Object.entries(snapshot.providers.openai)[0]!;
    expect((await catalog.models("openai"))[id]).toEqual({ cost });
    expect(await catalog.models("custom")).toEqual({});
    expect(stub).toHaveBeenCalledTimes(1);
  });
});
