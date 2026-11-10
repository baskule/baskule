import { languageNames, locales, useTranslation } from "../../i18n";
import { setLanguagePreference, useLanguagePreference } from "../../languagePreferences";
import { useState } from "react";
import { View } from "react-native";
import { SettingsSection } from "./components/SettingsSection";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { ErrorBanner } from "../../components/ui/ErrorBanner";

import type { LanguagePreference } from "@t3tools/shared/localization";
import { isLanguagePreference } from "@t3tools/shared/localization";
import { Menu } from "../../components/ui/Menu";
import { Button } from "../../components/ui/Button";

export function LanguageSetting({ compact = false }: { readonly compact?: boolean }) {
  const t = useTranslation();
  const preference = useLanguagePreference();
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const select = async (value: LanguagePreference) => {
    setSaving(true);
    setError(false);
    await setLanguagePreference(value)
      .catch(() => setError(true))
      .finally(() => setSaving(false));
  };
  if (compact) {
    const current = preference === "auto" ? t("System language") : languageNames[preference];
    return (
      <View className="items-center gap-2">
        <Menu
          accessible
          accessibilityLabel={t("Language: {{language}}", { language: current })}
          accessibilityRole="button"
          actions={[
            {
              id: "auto",
              title: t("Use system language"),
              state: preference === "auto" ? "on" : "off",
            },
            ...locales.map((locale) => ({
              id: locale,
              title: languageNames[locale],
              state: preference === locale ? ("on" as const) : ("off" as const),
            })),
          ]}
          onPressAction={({ nativeEvent }) => {
            if (!saving && isLanguagePreference(nativeEvent.event)) void select(nativeEvent.event);
          }}
        >
          <Button label={current} icon="globe" tone="text" disabled={saving} onPress={() => {}} />
        </Menu>
        {error ? <ErrorBanner message={t("Could not save the language. Try again.")} /> : null}
      </View>
    );
  }
  return (
    <SettingsSection title={t("Language")} footer={t("Applies to this device.")}>
      <SettingsChoiceRow
        label={t("Use system language")}
        selected={preference === "auto"}
        disabled={saving}
        onPress={() => void select("auto")}
      />
      {locales.map((locale) => (
        <SettingsChoiceRow
          key={locale}
          label={languageNames[locale]}
          selected={preference === locale}
          separated
          disabled={saving}
          onPress={() => void select(locale)}
        />
      ))}
      {error ? <ErrorBanner message={t("Could not save the language. Try again.")} /> : null}
    </SettingsSection>
  );
}
