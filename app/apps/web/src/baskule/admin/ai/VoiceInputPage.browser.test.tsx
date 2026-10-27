// baskule: AI → Voice input when the chat model moves onto the transcription connection meanwhile.
import "~/index.css";

import {
  blankBaskuleModel,
  DEFAULT_BASKULE_TRANSCRIPTION,
  type BaskuleAdminSettings,
} from "@t3tools/contracts/baskule";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";

const api = vi.hoisted(() => ({
  settings: null as BaskuleAdminSettings | null,
  saves: 0,
}));

vi.mock("../../api", async (original) => {
  const actual = await original<typeof import("../../api")>();
  return {
    ...actual,
    baskuleApi: {
      adminSettings: async () => api.settings!,
      saveSettings: async () => {
        api.saves += 1;
        const { message, code } = actual.messageFromBody(
          { error: "shared_api_key", message: "shared_api_key" },
          400,
        );
        throw new actual.BaskuleApiError(400, message, code);
      },
    },
  };
});
vi.mock("../../session", () => ({ refreshBaskuleMe: async () => null }));

const { VoiceInputPage } = await import("./VoiceInputPage");

const settings = (chat: BaskuleAdminSettings["ai"]): BaskuleAdminSettings => ({
  organizationName: "Acme",
  googleSignupDomains: [],
  idleMinutes: 30,
  ai: chat,
  transcription: DEFAULT_BASKULE_TRANSCRIPTION,
  apiKeyConfigured: true,
  transcriptionApiKeyConfigured: true,
  authentication: { mode: "authenticated", password: true, providers: [] },
});

it("shows a refused key removal and then the key as shared with chat", async () => {
  api.settings = settings({
    providerId: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: blankBaskuleModel(),
  });
  api.saves = 0;
  await using screen = await render(<VoiceInputPage />);
  const remove = screen.getByRole("checkbox", { name: "Remove the saved key" });
  await userEvent.click(remove);

  api.settings = settings({
    providerId: "openai",
    baseUrl: DEFAULT_BASKULE_TRANSCRIPTION.baseUrl,
    model: blankBaskuleModel(),
  });
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("This key is shared with chat. Change it on AI → Models.");
  await expect.element(screen.getByText(/so they share one key/)).toBeVisible();
  expect(remove.query()).toBeNull();
  expect(api.saves).toBe(1);
});
