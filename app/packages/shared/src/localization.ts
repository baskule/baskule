import { createInstance } from "i18next";

export const locales = ["en", "fr", "es", "de", "nl", "it"] as const;
export type Locale = (typeof locales)[number];
export type LanguagePreference = Locale | "auto";
export const languageNames: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  de: "Deutsch",
  nl: "Nederlands",
  it: "Italiano",
};

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "auto" || locales.some((locale) => locale === value);
}

export function resolveLocale(
  preference: LanguagePreference,
  languages: readonly string[],
): Locale {
  if (preference !== "auto") return preference;
  for (const language of languages) {
    const base = language.toLowerCase().replaceAll("_", "-").split("-")[0];
    const locale = locales.find((candidate) => candidate === base);
    if (locale) return locale;
  }
  return "en";
}

export const i18n = createInstance();
void i18n.init({
  lng: "en",
  fallbackLng: "en",
  supportedLngs: [...locales],
  resources: { en: { translation: {} } },
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

// English messages are the keys, so new UI still works before catalogs are generated.
export function t(
  message: string,
  values: Record<string, string | number | boolean | null | undefined> = {},
): string {
  return i18n.t(message, { ...values, defaultValue: message });
}

const catalogs = {
  fr: () => import("./locales/fr.ts"),
  es: () => import("./locales/es.ts"),
  de: () => import("./locales/de.ts"),
  nl: () => import("./locales/nl.ts"),
  it: () => import("./locales/it.ts"),
};
let activation = 0;

export async function activateLocale(locale: Locale): Promise<void> {
  const request = ++activation;
  if (locale !== "en" && !i18n.hasResourceBundle(locale, "translation")) {
    const catalog = await catalogs[locale]();
    i18n.addResourceBundle(locale, "translation", catalog.default);
  }
  // A slow first download must not undo a more recent selection.
  if (request === activation) await i18n.changeLanguage(locale);
}

export const getLocale = (): Locale => locales.find((locale) => locale === i18n.language) ?? "en";
export function subscribeLocale(listener: () => void): () => void {
  i18n.on("languageChanged", listener);
  return () => {
    i18n.off("languageChanged", listener);
  };
}

// Tag an English label that also serves as a model key; translate it only where it is displayed.
export const msg = <const Message extends string>(message: Message): Message => message;
