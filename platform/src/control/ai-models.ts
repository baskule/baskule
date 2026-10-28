// The admin's chat connection checks: list a provider's models, and prove a key and model work before
// they are saved. Built-in prices come from the presets and the model catalog, never from the client.
import { BASKULE_AI_PROVIDERS, type BaskuleAIModel, type BaskuleAIProviderId, type BaskuleAvailableModel } from "../../../app/packages/contracts/src/baskule";
import { HttpError } from "../shared/http";
import { ModelCatalog, type CatalogModel } from "./model-catalog";

export interface AIConnection { providerId: BaskuleAIProviderId; baseUrl: string; key: string }

interface ListedModel {
  id?: unknown;
  display_name?: unknown;
  max_context_length?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
  capabilities?: { completion_chat?: unknown };
}

const TIMEOUT_MS = 10_000;
/** Vendor APIs with a model lookup; the others are OpenAI-compatible endpoints probed with one short completion. */
const LOOKUP = new Set<BaskuleAIProviderId>(["openai", "anthropic", "mistral"]);
// OpenAI lists every model the key can use, including ones that cannot chat.
const OPENAI_NOT_CHAT = /embedding|whisper|tts|transcribe|dall-e|image|moderation|realtime|audio|search|davinci|babbage|sora/;
const whole = (value: unknown) => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined);
const valid = (limit: CatalogModel["limit"]) => (limit && limit.output < limit.context ? limit : undefined);

export class AIModels {
  private catalog = new ModelCatalog();

  async available(connection: AIConnection): Promise<BaskuleAvailableModel[]> {
    const { providerId } = connection;
    const response = await this.request(connection, providerId === "anthropic" ? "/models?limit=1000" : "/models");
    const body = await response.json().catch(() => null) as { data?: ListedModel[] } | null;
    if (!Array.isArray(body?.data)) throw new HttpError(502, "ai_provider_error", "The provider did not return a model list");
    const presets = BASKULE_AI_PROVIDERS[providerId].models;
    const catalog = providerId === "custom" ? {} : await this.catalog.models(providerId);
    const seen = new Set<string>();
    const models = body.data.flatMap((entry): BaskuleAvailableModel[] => {
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!id || id.length > 200 || seen.has(id)) return [];
      if (providerId === "mistral" && entry.capabilities?.completion_chat === false) return [];
      if (providerId === "openai" && OPENAI_NOT_CHAT.test(id)) return [];
      seen.add(id);
      const preset = presets.find((model) => model.id === id);
      const known = catalog[id];
      const context = whole(entry.max_input_tokens) ?? whole(entry.max_context_length);
      const output = whole(entry.max_tokens);
      const listed = typeof entry.display_name === "string" ? entry.display_name : undefined;
      const limit = preset?.limit ?? valid(known?.limit) ?? valid(context && output ? { context, output } : undefined);
      const cost = preset?.cost ?? known?.cost;
      return [{ id, name: preset?.name ?? listed ?? known?.name ?? id, ...(limit ? { limit } : {}), ...(cost ? { cost } : {}) }];
    });
    const rank = (model: BaskuleAvailableModel) => {
      const index = presets.findIndex((preset) => preset.id === model.id);
      return index < 0 ? presets.length : index;
    };
    return models.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  /** Throws the reason the connection cannot answer with this model. */
  async verify(connection: AIConnection, modelId: string): Promise<void> {
    if (LOOKUP.has(connection.providerId)) {
      await this.request(connection, `/models/${encodeURIComponent(modelId)}`, undefined, modelId);
      return;
    }
    const response = await this.request(connection, "/chat/completions", {
      model: modelId, messages: [{ role: "user", content: "Hi" }], max_tokens: 16,
    }, modelId);
    const body = await response.json().catch(() => null) as { choices?: unknown } | null;
    if (!Array.isArray(body?.choices))
      throw new HttpError(502, "ai_provider_error", "The endpoint did not answer like an OpenAI-compatible Chat Completions API");
  }

  async price(providerId: BaskuleAIProviderId, modelId: string): Promise<BaskuleAIModel["cost"]> {
    const preset = BASKULE_AI_PROVIDERS[providerId].models.find((model) => model.id === modelId);
    if (preset || providerId === "custom") return preset?.cost;
    return (await this.catalog.models(providerId))[modelId]?.cost;
  }

  private async request(connection: AIConnection, path: string, body?: unknown, modelId?: string): Promise<Response> {
    const { providerId, key } = connection;
    if (!key && LOOKUP.has(providerId)) throw new HttpError(400, "ai_key_missing", "Enter the provider's API key");
    const url = `${connection.baseUrl.replace(/\/+$/, "")}${path}`;
    const headers: Record<string, string> = providerId === "anthropic"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : key ? { authorization: `Bearer ${key}` } : {};
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST", headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new HttpError(502, "ai_provider_unreachable", `Could not reach ${new URL(url).host}`);
    }
    if (response.ok) return response;
    // Some providers quote part of a rejected key: never pass their message on for authentication failures.
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new HttpError(400, "ai_key_rejected", "The provider rejected the API key");
    }
    const detail = await providerMessage(response, key);
    if (response.status === 404 && modelId !== undefined)
      throw new HttpError(400, "ai_model_not_found", detail ?? `The provider has no model ${modelId}`);
    throw new HttpError(502, "ai_provider_error", `The provider answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

// Provider messages may quote the key: redact the decoded message before truncation can split it.
async function providerMessage(response: Response, key: string): Promise<string | undefined> {
  const text = await response.text().catch(() => "");
  let message: unknown = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    message = typeof parsed.error === "object" ? parsed.error?.message : parsed.error ?? parsed.message ?? parsed.detail;
  } catch { /* plain-text error body */ }
  if (typeof message !== "string") return undefined;
  const redacted = (key ? message.replaceAll(key, "•••") : message).trim();
  return redacted ? redacted.slice(0, 300) : undefined;
}
