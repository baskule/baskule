import { useSyncExternalStore } from "react";
import {
  activateLocale,
  getLocale,
  isLanguagePreference,
  resolveLocale,
  subscribeLocale,
  type LanguagePreference,
} from "@t3tools/shared/localization";

export { t, languageNames, locales } from "@t3tools/shared/localization";
const storageKey = "baskule.language";
let preference: LanguagePreference = "auto";
try {
  const cookie =
    typeof document === "undefined"
      ? undefined
      : document.cookie
          .split("; ")
          .find((entry) => entry.startsWith("baskule_language="))
          ?.split("=")[1];
  const saved = cookie ?? localStorage.getItem(storageKey);
  if (isLanguagePreference(saved)) preference = saved;
} catch {
  /* Storage may be disabled; the selection still works for this session. */
}

async function applyLanguage() {
  const languages = typeof navigator === "undefined" ? [] : navigator.languages;
  await activateLocale(resolveLocale(preference, languages));
  if (typeof document !== "undefined") document.documentElement.lang = getLocale();
}

export const languageReady = applyLanguage().catch(() => activateLocale("en"));
export function useLanguagePreference() {
  return useSyncExternalStore(
    subscribeLocale,
    () => preference,
    () => "auto" as const,
  );
}
export async function setLanguagePreference(value: LanguagePreference) {
  const previous = preference;
  preference = value;
  try {
    await applyLanguage();
  } catch (error) {
    if (preference === value) {
      preference = previous;
      await applyLanguage();
    }
    throw error;
  }
  if (preference !== value) return;
  document.cookie = `baskule_language=${value}; Path=/; SameSite=Lax; Max-Age=31536000`;
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    /* Session-only selection. */
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("languagechange", () => {
    if (preference === "auto") void applyLanguage();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = isLanguagePreference(event.newValue) ? event.newValue : "auto";
    void applyLanguage();
  });
}
