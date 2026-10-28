import { z } from "zod";
import { DEFAULT_BASKULE_TRANSCRIPTION, BASKULE_AI_PROVIDERS } from "../../../app/packages/contracts/src/baskule";
import { HttpError } from "../shared/http";

const endpoint = z.url().refine(value => {
  const u = new URL(value);
  return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
}, "Use an HTTP(S) endpoint without credentials, query or fragment");
const modelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(100),
  image: z.boolean(),
  pdf: z.boolean(),
  limit: z.object({
    context: z.number().int().min(1024).max(10_000_000),
    output: z.number().int().min(1).max(1_000_000),
  }).strict(),
  cost: z.object({
    input: z.number().min(0),
    output: z.number().min(0),
    cache_read: z.number().min(0).optional(),
    cache_write: z.number().min(0).optional(),
  }).strict().optional(),
  settings: z.record(z.string(), z.json()),
}).strict().refine(m => m.limit.output < m.limit.context, "Output limit must be smaller than the context window");
const providerId = z.enum(["openai", "anthropic", "mistral", "opencode", "custom"]);
const connectionCheckSchema = z.object({
  providerId,
  baseUrl: endpoint,
  apiKey: z.string().max(8192).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
}).strict();
export const settingsSchema = z.object({
  organizationName: z.string().trim().min(1).max(100),
  googleSignupDomains: z.array(z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/, "Use an email domain such as company.com")).max(30).default([]),
  ai: z.object({
    providerId,
    baseUrl: endpoint,
    model: modelSchema,
  }).strict(),
  transcription: z.object({
    enabled: z.boolean(),
    providerId: z.enum(["openai", "custom"]),
    baseUrl: endpoint,
    model: z.string().trim().min(1).max(200),
  }).strict(),
  idleMinutes: z.number().min(0.1).max(1440),
}).strict();
export type ProductSettings = z.infer<typeof settingsSchema>;

export const defaultSettings: ProductSettings = {
  organizationName: "Baskule",
  googleSignupDomains: [],
  ai: { providerId: "mistral", baseUrl: BASKULE_AI_PROVIDERS.mistral.baseUrl,
    model: modelSchema.parse(BASKULE_AI_PROVIDERS.mistral.models[0]) },
  transcription: DEFAULT_BASKULE_TRANSCRIPTION,
  idleMinutes: 10,
};

export function parseSettings(input: unknown): ProductSettings {
  const result = settingsSchema.safeParse(input);
  if (!result.success) throw new HttpError(400, "invalid_settings", result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return result.data;
}

export function parseConnectionCheck(input: unknown): z.infer<typeof connectionCheckSchema> {
  const result = connectionCheckSchema.safeParse(input);
  if (!result.success) throw new HttpError(400, "invalid_connection", result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return result.data;
}
