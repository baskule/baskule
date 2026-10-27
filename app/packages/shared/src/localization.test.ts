import { describe, expect, it } from "vite-plus/test";
import {
  activateLocale,
  getLocale,
  i18n,
  isLanguagePreference,
  resolveLocale,
  t,
} from "./localization";

describe("language selection", () => {
  it("uses the first supported browser or OS language, including regional variants", () => {
    expect(resolveLocale("auto", ["ja-JP", "fr-CA", "de-DE"])).toBe("fr");
    expect(resolveLocale("auto", ["NL_be"])).toBe("nl");
    expect(resolveLocale("auto", ["es-MX"])).toBe("es");
    expect(resolveLocale("auto", ["de-AT"])).toBe("de");
    expect(resolveLocale("auto", ["it-CH"])).toBe("it");
  });

  it("honors an explicit override and falls back to English without information", () => {
    expect(resolveLocale("en", ["fr-FR"])).toBe("en");
    expect(resolveLocale("it", [])).toBe("it");
    expect(resolveLocale("auto", [])).toBe("en");
    expect(resolveLocale("auto", ["ja-JP", "ar"])).toBe("en");
    expect(isLanguagePreference("fr-CA")).toBe(false);
    expect(isLanguagePreference("auto")).toBe(true);
    expect(isLanguagePreference(null)).toBe(false);
  });
});

it("keeps English source text for missing translations and interpolates user content as text", () => {
  expect(t("Hello {{name}}!", { name: "<Alice & Bob>" })).toBe("Hello <Alice & Bob>!");
  expect(t("A newly added English message")).toBe("A newly added English message");
});

it("uses plural forms rather than concatenating a translated noun with an English suffix", () => {
  const key = "{{count}} example";
  i18n.addResourceBundle("en", "translation", {
    [`${key}_one`]: "{{count}} example",
    [`${key}_other`]: "{{count}} examples",
  });
  expect(t(key, { count: 1, defaultValue_other: "{{count}} examples" })).toBe("1 example");
  expect(t(key, { count: 0, defaultValue_other: "{{count}} examples" })).toBe("0 examples");
  expect(t(key, { count: 2, defaultValue_other: "{{count}} examples" })).toBe("2 examples");
});

it("does not let a slow catalog import replace a more recent choice", async () => {
  const first = activateLocale("it");
  await activateLocale("en");
  await first;
  expect(getLocale()).toBe("en");
});
