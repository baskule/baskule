import snapshot from "./data/model-prices.json";
import type { BaskuleAIModel } from "../../../app/packages/contracts/src/baskule";

type Cost = NonNullable<BaskuleAIModel["cost"]>;
export interface CatalogModel { name?: string; cost?: Cost; limit?: BaskuleAIModel["limit"] }
type Catalog = Record<string, Record<string, CatalogModel>>;
const PROVIDERS = ["mistral", "openai", "anthropic"];
const LIVE_MS = 3_600_000;
// Retrying an unreachable models.dev on every lookup would add its timeout to each admin action.
const SNAPSHOT_MS = 300_000;

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const costOf = (value: unknown): Cost | undefined => {
  const cost = value as Partial<Cost> | undefined;
  if (!cost || !finite(cost.input) || !finite(cost.output)) return undefined;
  return { input: cost.input!, output: cost.output!,
    ...(finite(cost.cache_read) ? { cache_read: cost.cache_read } : {}), ...(finite(cost.cache_write) ? { cache_write: cost.cache_write } : {}) };
};
const limitOf = (value: unknown): CatalogModel["limit"] => {
  const limit = value as { context?: unknown; output?: unknown } | undefined;
  const whole = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
  return limit && whole(limit.context) && whole(limit.output) ? { context: limit.context as number, output: limit.output as number } : undefined;
};

/** What models.dev knows about the built-in providers' models; its generated price snapshot when unreachable. */
export class ModelCatalog {
  private cached: { until: number; providers: Catalog } | undefined;
  async models(provider: string): Promise<Record<string, CatalogModel>> {
    if (!this.cached || this.cached.until < Date.now()) this.cached = await this.load();
    return this.cached.providers[provider] ?? {};
  }
  private async load(): Promise<{ until: number; providers: Catalog }> {
    try {
      const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const catalog = await response.json() as Record<string, { models?: Record<string, { name?: unknown; cost?: unknown; limit?: unknown }> }>;
      const providers: Catalog = {};
      for (const id of PROVIDERS) {
        if (!catalog[id]?.models) throw new Error("Invalid models.dev catalog");
        providers[id] = Object.fromEntries(Object.entries(catalog[id].models).map(([key, value]) => [key, {
          ...(typeof value.name === "string" ? { name: value.name } : {}),
          ...(costOf(value.cost) ? { cost: costOf(value.cost) } : {}),
          ...(limitOf(value.limit) ? { limit: limitOf(value.limit) } : {}),
        }]));
      }
      return { until: Date.now() + LIVE_MS, providers };
    } catch {
      const providers: Catalog = Object.fromEntries(Object.entries(snapshot.providers).map(([id, models]) => [id,
        Object.fromEntries(Object.entries(models).map(([key, cost]) => [key, costOf(cost) ? { cost: costOf(cost) } : {}]))]));
      return { until: Date.now() + SNAPSHOT_MS, providers };
    }
  }
}
