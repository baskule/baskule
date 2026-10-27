import { useSyncExternalStore } from "react";
import {
  t as translate,
  i18n,
  getLocale,
  subscribeLocale,
  type Locale,
} from "@t3tools/shared/localization";
export { t, msg, languageNames, locales } from "@t3tools/shared/localization";

export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, () => "en" as const);
}

// One translator per locale: its identity changes only with the locale, so compiler caches
// that depend on it are invalidated by a language switch and kept on every other render.
const translators = new Map<Locale, typeof translate>();

function translatorFor(locale: Locale): typeof translate {
  let translator = translators.get(locale);
  if (translator === undefined) {
    // Callbacks retained by effects still read the current locale.
    translator = (message, values) =>
      i18n.t(message, { ...values, lng: getLocale(), defaultValue: message });
    translators.set(locale, translator);
  }
  return translator;
}

export function useTranslation() {
  return translatorFor(useLocale());
}
