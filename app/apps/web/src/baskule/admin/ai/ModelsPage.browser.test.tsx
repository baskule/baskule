import { DEFAULT_BASKULE_TRANSCRIPTION, BASKULE_AI_PROVIDERS } from "@t3tools/contracts/baskule";
import { render } from "../../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { BaskuleAdminSettings, BaskuleProductSettings } from "../../api";

type Saved = BaskuleProductSettings & { readonly apiKey?: string };

const api = vi.hoisted(() => ({
  settings: null as unknown as BaskuleAdminSettings,
  saved: [] as Saved[],
}));

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  baskuleApi: {
    adminSettings: async () => api.settings,
    saveSettings: async (settings: Saved) => {
      api.saved.push(settings);
      const { apiKey: _key, ...saved } = settings;
      return { ...api.settings, ...saved };
    },
  },
}));

const setup = () => {
  const mistral = BASKULE_AI_PROVIDERS.mistral;
  api.settings = {
    organizationName: "Acme",
    googleSignupDomains: [],
    idleMinutes: 30,
    ai: { providerId: "mistral", baseUrl: mistral.baseUrl, model: mistral.models[0]! },
    apiKeyConfigured: true,
    transcription: DEFAULT_BASKULE_TRANSCRIPTION,
    transcriptionApiKeyConfigured: false,
    authentication: { mode: "authenticated", password: true, providers: [] },
  };
  api.saved = [];
};

const { ModelsPage } = await import("./ModelsPage");

describe("AI models page", () => {
  it("saves OpenCode's free model without a key, after its data-use warning", async () => {
    setup();
    await using screen = await render(<ModelsPage />);
    await expect.element(screen.getByLabelText("API key")).toBeVisible();
    await userEvent.click(screen.getByRole("radio", { name: /OpenCode \(free\)/ }));
    await expect
      .element(screen.getByText(/^Free model hosted by OpenCode\. Prompts are sent/))
      .toBeVisible();
    expect(screen.getByLabelText("API key").query()).toBeNull();
    expect(screen.getByLabelText("API endpoint").query()).toBeNull();
    await expect.element(screen.getByLabelText("Model ID")).toHaveValue("deepseek-v4.1-flash-free");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await vi.waitFor(() => expect(api.saved).toHaveLength(1));
    const [saved] = api.saved;
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved?.ai).toEqual({
      providerId: "opencode",
      baseUrl: BASKULE_AI_PROVIDERS.opencode.baseUrl,
      model: BASKULE_AI_PROVIDERS.opencode.models[0],
    });
  });
});
