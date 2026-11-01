import { languageNames, locales, useTranslation } from "../i18n";
import { setLanguagePreference, useLanguagePreference } from "../languagePreferences";
import { useState } from "react";
import { isLanguagePreference } from "@t3tools/shared/localization";
import { SettingsRow } from "./settings/settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export function LanguageSetting() {
  const t = useTranslation();
  const preference = useLanguagePreference();
  const [error, setError] = useState(false);
  return (
    <SettingsRow
      title={t("Language")}
      description={
        error ? (
          <span role="alert" className="text-destructive-foreground">
            {t("Could not save the language. Try again.")}
          </span>
        ) : (
          t("Applies to this device.")
        )
      }
      control={
        <div className="w-52">
          <Select
            items={[
              { value: "auto", label: t("Use system language") },
              ...locales.map((locale) => ({ value: locale, label: languageNames[locale] })),
            ]}
            value={preference}
            onValueChange={(value) => {
              if (isLanguagePreference(value)) {
                setError(false);
                void setLanguagePreference(value).catch(() => setError(true));
              }
            }}
          >
            <SelectTrigger aria-label={t("Language")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="auto">{t("Use system language")}</SelectItem>
              {locales.map((locale) => (
                <SelectItem key={locale} value={locale}>
                  {languageNames[locale]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
