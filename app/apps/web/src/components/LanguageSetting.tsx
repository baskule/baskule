import { setLanguagePreference, useLanguagePreference } from "../languagePreferences";
import { useId, useState } from "react";
import { isLanguagePreference } from "@t3tools/shared/localization";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { languageNames, locales, useTranslation } from "../i18n";

export function LanguageSetting() {
  const t = useTranslation();
  const id = useId();
  const preference = useLanguagePreference();
  const [error, setError] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{t("Language")}</Label>
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
        <SelectTrigger id={id} className="w-full">
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
      <p className="text-xs text-muted-foreground">{t("Applies to this device.")}</p>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {t("Could not save the language. Try again.")}
        </p>
      ) : null}
    </div>
  );
}
