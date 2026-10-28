import { DEFAULT_BASKULE_TRANSCRIPTION, BASKULE_AI_PROVIDERS } from "@t3tools/contracts/baskule";
import { render } from "../../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type {
  BaskuleAIConnectionCheck,
  BaskuleAdminSettings,
  BaskuleAvailableModel,
  BaskuleProductSettings,
} from "../../api";
import { SAVED_KEY_MASK } from "./modelsForm";

type Saved = BaskuleProductSettings & { readonly apiKey?: string };

const api = vi.hoisted(() => ({
  settings: null as unknown as BaskuleAdminSettings,
  models: [] as BaskuleAvailableModel[],
  saved: [] as Saved[],
  listed: [] as BaskuleAIConnectionCheck[],
  checked: [] as BaskuleAIConnectionCheck[],
}));

vi.mock("../../api", async (original) => {
  const actual = await original<typeof import("../../api")>();
  return {
    ...actual,
    baskuleApi: {
      adminSettings: async () => api.settings,
      saveSettings: async (settings: Saved) => {
        api.saved.push(settings);
        const { apiKey: _key, ...saved } = settings;
        return { ...api.settings, ...saved };
      },
      aiModels: async (connection: BaskuleAIConnectionCheck) => {
        api.listed.push(connection);
        return api.models;
      },
      // The provider rejects keys starting with "bad".
      verifyAI: async (check: BaskuleAIConnectionCheck) => {
        api.checked.push(check);
        if (check.apiKey?.startsWith("bad"))
          throw new actual.BaskuleApiError(
            400,
            "The provider rejected this API key.",
            "ai_key_rejected",
          );
        return { ok: true };
      },
    },
  };
});

const mistral = BASKULE_AI_PROVIDERS.mistral;
const small = {
  id: "mistral-small-2603",
  name: "Mistral Small 4",
  limit: { context: 262_144, output: 256_000 },
  cost: { input: 0.15, output: 0.6, cache_read: 0.015 },
};

const setup = () => {
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
  api.models = [{ id: mistral.models[0]!.id, name: mistral.models[0]!.name }, small];
  api.saved = [];
  api.listed = [];
  api.checked = [];
};

// The check waits for typing to pause before asking the provider.
const CHECK = { timeout: 5_000 };

const { ModelsPage } = await import("./ModelsPage");

async function chooseProvider(name: string) {
  await userEvent.click(page.getByLabelText("Provider", { exact: true }));
  await userEvent.click(page.getByRole("option", { name, exact: true }));
}

describe("AI models page", () => {
  it("shows a saved key as dots and saves a listed model once its connection works", async () => {
    setup();
    await using screen = await render(<ModelsPage />);
    const key = screen.getByLabelText("API key", { exact: true });
    await expect.element(key).toHaveValue(SAVED_KEY_MASK);
    const save = screen.getByRole("button", { name: "Save settings" });
    await expect.element(save).toBeDisabled();
    // The list loads only when the picker opens.
    expect(api.listed).toEqual([]);
    await userEvent.click(screen.getByLabelText("Model", { exact: true }));
    await userEvent.click(page.getByRole("option", { name: /Mistral Small 4/ }));
    expect(api.listed).toEqual([{ providerId: "mistral", baseUrl: mistral.baseUrl }]);
    await expect.element(save).toBeDisabled();
    await expect
      .element(screen.getByText("Connection works", { exact: true }), CHECK)
      .toBeVisible();
    await expect.element(screen.getByText("$0.15")).toBeVisible();
    await expect.element(screen.getByLabelText("Context window (tokens)")).toHaveValue(262144);
    await expect.element(screen.getByRole("switch", { name: "PDFs" })).toBeChecked();
    await userEvent.click(save);
    await vi.waitFor(() => expect(api.saved).toHaveLength(1));
    const [saved] = api.saved;
    expect(saved).not.toHaveProperty("apiKey");
    // Built-in prices are the ControlCell's to set.
    expect(saved?.ai.model).not.toHaveProperty("cost");
    expect(saved?.ai.model).toMatchObject({
      id: small.id,
      name: small.name,
      image: true,
      pdf: true,
    });
    expect(api.checked).toEqual([
      { providerId: "mistral", baseUrl: mistral.baseUrl, modelId: small.id },
    ]);
  });

  it("keeps Save off for a key the provider rejects", async () => {
    setup();
    await using screen = await render(<ModelsPage />);
    const key = screen.getByLabelText("API key", { exact: true });
    const save = screen.getByRole("button", { name: "Save settings" });
    await userEvent.click(key);
    await userEvent.keyboard("bad-key");
    await expect.element(key).toHaveValue("bad-key");
    await expect
      .element(screen.getByText("The provider rejected this API key.", { exact: true }), CHECK)
      .toBeVisible();
    await expect.element(key).toHaveAttribute("aria-invalid", "true");
    await expect.element(save).toBeDisabled();
    await userEvent.clear(key);
    await userEvent.type(key, "good-key");
    await expect
      .element(screen.getByText("Connection works", { exact: true }), CHECK)
      .toBeVisible();
    await userEvent.click(save);
    await vi.waitFor(() => expect(api.saved).toHaveLength(1));
    expect(api.saved[0]?.apiKey).toBe("good-key");
  });

  it("saves OpenCode's free model without a key, after its data-use warning", async () => {
    setup();
    await using screen = await render(<ModelsPage />);
    await expect.element(screen.getByLabelText("API key", { exact: true })).toBeVisible();
    await chooseProvider("OpenCode (free)");
    await expect
      .element(screen.getByText(/^Free model hosted by OpenCode\. Prompts are sent/))
      .toBeVisible();
    expect(screen.getByLabelText("API key", { exact: true }).query()).toBeNull();
    expect(screen.getByLabelText("API endpoint", { exact: true }).query()).toBeNull();
    await expect.element(screen.getByText("Free", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByText("Connection works", { exact: true }), CHECK)
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await vi.waitFor(() => expect(api.saved).toHaveLength(1));
    const [saved] = api.saved;
    expect(saved).not.toHaveProperty("apiKey");
    const { cost: _cost, ...preset } = BASKULE_AI_PROVIDERS.opencode.models[0]!;
    expect(saved?.ai).toEqual({
      providerId: "opencode",
      baseUrl: BASKULE_AI_PROVIDERS.opencode.baseUrl,
      model: { ...preset, image: true, pdf: true },
    });
  });

  it("takes any model ID and every price for a custom endpoint", async () => {
    setup();
    await using screen = await render(<ModelsPage />);
    await chooseProvider("Custom");
    await userEvent.fill(
      screen.getByLabelText("API endpoint", { exact: true }),
      "https://llm.example.test/v1",
    );
    await userEvent.fill(screen.getByLabelText("Model", { exact: true }), "local-model");
    const [input, output, cacheRead, cacheWrite] = [
      "Input",
      "Output",
      "Cache read",
      "Cache write",
    ].map((label) => screen.getByRole("spinbutton", { name: label, exact: true }));
    await userEvent.fill(input!, "0.5");
    await userEvent.fill(output!, "1.5");
    await userEvent.fill(cacheRead!, "0.05");
    await userEvent.fill(cacheWrite!, "0.6");
    await expect
      .element(screen.getByText("Connection works", { exact: true }), CHECK)
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await vi.waitFor(() => expect(api.saved).toHaveLength(1));
    expect(api.saved[0]?.ai).toMatchObject({
      providerId: "custom",
      baseUrl: "https://llm.example.test/v1",
      model: {
        id: "local-model",
        name: "local-model",
        cost: { input: 0.5, output: 1.5, cache_read: 0.05, cache_write: 0.6 },
      },
    });
  });
});
