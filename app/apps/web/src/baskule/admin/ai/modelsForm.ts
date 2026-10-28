// baskule: the rules of the AI → Models form, apart from its rendering.
import {
  BASKULE_AI_PROVIDERS,
  blankBaskuleModel,
  type BaskuleAIConnectionCheck,
  type BaskuleAIModel,
  type BaskuleAIProviderId,
  type BaskuleAvailableModel,
} from "@t3tools/contracts/baskule";

const MASK_CHARACTER = "•";
/** Fills the key field while a key is saved: never the key itself, which stays on the server. */
export const SAVED_KEY_MASK = MASK_CHARACTER.repeat(20);

/** The key typed into the field; any edit of the mask keeps only what was typed, so typing replaces it. */
export function typedKey(fieldValue: string, masked: boolean): string {
  return masked ? fieldValue.replaceAll(MASK_CHARACTER, "") : fieldValue;
}

/** The provider's suggested model, which takes images and PDFs until the admin says otherwise. */
export function defaultModel(providerId: BaskuleAIProviderId): BaskuleAIModel {
  return {
    ...(BASKULE_AI_PROVIDERS[providerId].models[0] ?? blankBaskuleModel()),
    image: true,
    pdf: true,
  };
}

/** A listed model, with its known limits; images and PDFs on, as for any new model. */
export function modelFromListing(listed: BaskuleAvailableModel): BaskuleAIModel {
  return {
    ...blankBaskuleModel(),
    id: listed.id,
    name: listed.name,
    ...(listed.limit ? { limit: listed.limit } : {}),
    ...(listed.cost ? { cost: listed.cost } : {}),
  };
}

/** The connection the provider is asked about. Without a typed key, the server uses the saved one. */
export function connectionOf(
  providerId: BaskuleAIProviderId,
  baseUrl: string,
  key: string | null,
): BaskuleAIConnectionCheck {
  return {
    providerId,
    baseUrl,
    ...(key === null || BASKULE_AI_PROVIDERS[providerId].keyless ? {} : { apiKey: key }),
  };
}

/** What the connection check needs, or null while the model or endpoint is missing. */
export function connectionCheckOf(
  providerId: BaskuleAIProviderId,
  baseUrl: string,
  key: string | null,
  modelId: string,
): (BaskuleAIConnectionCheck & { readonly modelId: string }) | null {
  const id = modelId.trim();
  if (!id || !isHttpUrl(baseUrl)) return null;
  return { ...connectionOf(providerId, baseUrl, key), modelId: id };
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** The model's token limits as the ControlCell accepts them. */
export function limitsAreValid({ context, output }: BaskuleAIModel["limit"]): boolean {
  return (
    Number.isInteger(context) &&
    Number.isInteger(output) &&
    context >= 1024 &&
    context <= 10_000_000 &&
    output >= 1 &&
    output <= 1_000_000 &&
    output < context
  );
}
