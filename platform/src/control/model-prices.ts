import snapshot from "./data/model-prices.json";
import type { ModelPriceSuggestion } from "../../../app/packages/contracts/src/baskule-usage";
import { HttpError } from "../shared/http";

interface CatalogCost { input: number; output: number; cache_read?: number; cache_write?: number }
type Prices = Record<string, Record<string, CatalogCost>>;
export class ModelPrices {
  private cached: { until: number; fetchedAt: string; providers: Prices } | undefined;
  async suggest(provider: string, model: string): Promise<ModelPriceSuggestion> {
    if (!["mistral", "openai", "anthropic"].includes(provider) || !model || model.length > 200) throw new HttpError(400, "invalid_model");
    let source: ModelPriceSuggestion["source"] = "models.dev";
    let data = this.cached;
    if (!data || data.until < Date.now()) {
      try {
        const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(3_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const catalog = await response.json() as Record<string, { models: Record<string, { cost?: CatalogCost }> }>;
        const providers: Prices = {};
        for (const id of ["mistral", "openai", "anthropic"]) {
          if (!catalog[id]?.models) throw new Error("Invalid models.dev catalog");
          providers[id] = Object.fromEntries(Object.entries(catalog[id].models).flatMap(([key, value]) => value.cost ? [[key, value.cost]] : []));
        }
        data = this.cached = { until: Date.now() + 3_600_000, fetchedAt: new Date().toISOString(), providers };
      } catch { data = undefined; }
    }
    if (!data) { source = "snapshot"; data = { until: 0, ...snapshot }; }
    const p = data.providers[provider]?.[model];
    if (!p || !Number.isFinite(p.input) || !Number.isFinite(p.output)) throw new HttpError(404, "model_price_not_found");
    return { provider, model, prices: { input: p.input, output: p.output,
      ...(p.cache_read === undefined ? {} : { cacheRead: p.cache_read }), ...(p.cache_write === undefined ? {} : { cacheWrite: p.cache_write }) }, source, fetchedAt: data.fetchedAt };
  }
}
