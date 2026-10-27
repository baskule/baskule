/** Installation capabilities and organization settings shared by Baskule clients. */
export interface BaskuleAuthConfig {
  mode: "authenticated" | "anonymous";
  password: boolean;
  providers: { id: string; name: string; type: "social" | "oidc" }[];
}
export type BaskuleAIProviderId = "openai" | "anthropic" | "mistral" | "opencode" | "custom";

export interface BaskuleAIModel {
  /** Native API ID; combined with providerId this is the models.dev lookup key. */
  id: string;
  name: string;
  image: boolean;
  pdf: boolean;
  limit: { context: number; output: number };
  /** Base USD rates per million tokens, matching models.dev. Missing means unknown, never free.
   * These presets are estimates; usage billing also needs vendor tiers and historical rates. */
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  settings: Record<string, unknown>;
}

// Curated presets checked 2026-10-24 against models.dev and the vendors' model documentation.
// Keep routing IDs independent of display names so usage records can retain provider/model identity.
export const BASKULE_AI_PROVIDERS: Record<
  BaskuleAIProviderId,
  {
    name: string;
    package: string;
    baseUrl: string;
    /** Served without an API key (OpenCode's public token); the admin enters none. */
    keyless?: boolean;
    models: BaskuleAIModel[];
  }
> = {
  mistral: {
    name: "Mistral",
    package: "@opencode/ai/providers/mistral",
    baseUrl: "https://api.mistral.ai/v1",
    models: [
      {
        id: "mistral-large-4",
        name: "Mistral Large 4",
        image: true,
        pdf: true,
        // models.dev records the API's 524K preview limit, below the advertised 1M window.
        limit: { context: 524_288, output: 262_144 },
        cost: { input: 0.68, output: 2.09, cache_read: 0.07 },
        settings: {},
      },
      {
        id: "mistral-small-2603",
        name: "Mistral Small 4",
        image: true,
        pdf: true,
        limit: { context: 262_144, output: 256_000 },
        cost: { input: 0.15, output: 0.6, cache_read: 0.015 },
        settings: {},
      },
    ],
  },
  openai: {
    name: "OpenAI",
    package: "@opencode/ai/providers/openai",
    baseUrl: "https://api.openai.com/v1",
    models: [
      {
        id: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        image: true,
        pdf: true,
        limit: { context: 1_050_000, output: 128_000 },
        cost: { input: 2, output: 10, cache_read: 0.1 },
        settings: {},
      },
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        image: true,
        pdf: true,
        limit: { context: 1_050_000, output: 128_000 },
        cost: { input: 10, output: 50, cache_read: 1 },
        settings: {},
      },
    ],
  },
  anthropic: {
    name: "Anthropic",
    package: "@opencode/ai/providers/anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: [
      {
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        image: true,
        pdf: true,
        limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
        settings: {},
      },
      {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        image: true,
        pdf: true,
        limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
        settings: {},
      },
    ],
  },
  // OpenCode Zen's free tier: keyless, prompts go to OpenCode's servers under its terms.
  opencode: {
    name: "OpenCode (free)",
    package: "@opencode/ai/providers/openai-compatible",
    baseUrl: "https://opencode.ai/inference/openai/v1",
    keyless: true,
    models: [
      {
        id: "deepseek-v4.1-flash-free",
        name: "DeepSeek V4.1 Flash (free)",
        image: true,
        pdf: false,
        limit: { context: 200_000, output: 32_000 },
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        settings: {},
      },
    ],
  },
  custom: {
    name: "Custom",
    package: "@opencode/ai/providers/openai-compatible",
    baseUrl: "",
    models: [],
  },
};

export function blankBaskuleModel(): BaskuleAIModel {
  return {
    id: "",
    name: "",
    image: false,
    pdf: false,
    limit: { context: 200_000, output: 16_000 },
    settings: {},
  };
}

/** Voice input: the composer records audio and an OpenAI-compatible `/audio/transcriptions` endpoint
 * turns it into prompt text. The API key lives in the same per-connection slot as the chat key, so an
 * OpenAI chat connection and OpenAI transcription share one key. */
export type BaskuleTranscriptionProviderId = "openai" | "custom";
export interface BaskuleTranscriptionSettings {
  enabled: boolean;
  providerId: BaskuleTranscriptionProviderId;
  baseUrl: string;
  model: string;
}
export const BASKULE_TRANSCRIPTION_PROVIDERS: Record<
  BaskuleTranscriptionProviderId,
  { name: string; baseUrl: string; models: { id: string; name: string }[] }
> = {
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-transcribe", name: "GPT Transcribe" },
      { id: "gpt-4o-mini-transcribe", name: "GPT-4o mini Transcribe" },
    ],
  },
  custom: { name: "OpenAI-compatible", baseUrl: "", models: [] },
};
export const DEFAULT_BASKULE_TRANSCRIPTION: BaskuleTranscriptionSettings = {
  enabled: true,
  providerId: "openai",
  baseUrl: BASKULE_TRANSCRIPTION_PROVIDERS.openai.baseUrl,
  model: "gpt-transcribe",
};
/** OpenAI's upload limit for `/audio/transcriptions`. */
export const BASKULE_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
/** `POST /api/baskule/transcriptions`: the raw recording as the body, its MIME type as content-type. */
export interface BaskuleTranscriptionResult {
  text: string;
}

export const BASKULE_MANAGEMENT_DESTINATIONS = [
  "/settings/account",
  "/settings/spaces",
  "/settings/plugins",
  "/settings/usage",
  "/admin",
] as const;

export type BaskuleManagementDestination = (typeof BASKULE_MANAGEMENT_DESTINATIONS)[number];

export function baskuleManagementDestination(
  value: string | null,
): BaskuleManagementDestination | null {
  return BASKULE_MANAGEMENT_DESTINATIONS.find((destination) => destination === value) ?? null;
}

export interface BaskuleProductSettings {
  googleSignupDomains: string[];
  organizationName: string;
  ai: {
    providerId: BaskuleAIProviderId;
    baseUrl: string;
    model: BaskuleAIModel;
  };
  idleMinutes: number;
  transcription: BaskuleTranscriptionSettings;
}
export interface BaskuleAdminSettings extends BaskuleProductSettings {
  apiKeyConfigured: boolean;
  /** A key is saved for the transcription connection (which may be the chat connection's slot). */
  transcriptionApiKeyConfigured: boolean;
  authentication: BaskuleAuthConfig;
  /** Returned by saves when one or more spaces could not acknowledge the refresh. */
  reloadPending?: boolean;
}
