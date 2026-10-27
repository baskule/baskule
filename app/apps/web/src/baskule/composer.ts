// baskule: composer copy for the Baskule UI (review M3).
import { BASKULE_UI } from "./flags";

/**
 * The provider is "unavailable" when the computer is down or still waking (computerd probe). Settings
 * are hidden, so upstream's "Enable a provider in Settings" would be a dead end.
 */
export const PROVIDER_UNAVAILABLE_SHORT = BASKULE_UI
  ? "The assistant's computer is unavailable, retrying…"
  : "Enable a provider in Settings";
export const PROVIDER_UNAVAILABLE_PLACEHOLDER = BASKULE_UI
  ? "The assistant's computer is unavailable, retrying…"
  : "Enable a provider in Settings to send a message";
