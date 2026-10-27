import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLocales } from "expo-localization";
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

export async function refreshLanguage() {
  await activateLocale(
    resolveLocale(
      preference,
      getLocales().map((locale) => locale.languageTag),
    ),
  );
}
export const languageReady = AsyncStorage.getItem(storageKey)
  .catch(() => null)
  .then(async (saved) => {
    if (isLanguagePreference(saved)) preference = saved;
    await refreshLanguage();
  });
export function useLanguagePreference() {
  return useSyncExternalStore(
    subscribeLocale,
    () => preference,
    () => "auto" as const,
  );
}
export async function setLanguagePreference(value: LanguagePreference) {
  // Do not advertise a saved preference if writing it failed.
  await AsyncStorage.setItem(storageKey, value);
  preference = value;
  await refreshLanguage();
}
