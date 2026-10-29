import { useState } from "react";
import { useTranslation } from "../../i18n";
import { useTheme } from "../../hooks/useTheme";
import { LanguageSetting } from "../../components/LanguageSetting";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";

export function PersonalSettingsView() {
  const t = useTranslation();
  const { resolvedTheme, setAppearanceMode, setTheme } = useTheme();
  const [error, setError] = useState(false);

  return (
    <SettingsPageContainer>
      <SettingsSection title={t("Language & appearance")} hideTitle>
        <SettingsRow
          title={t("Appearance")}
          control={
            <ToggleGroup
              aria-label={t("Appearance")}
              value={[resolvedTheme]}
              onValueChange={(values) => {
                const appearance = values[0] ?? resolvedTheme;
                if (appearance === "light" || appearance === "dark") {
                  setError(!setTheme("system") || !setAppearanceMode(appearance));
                }
              }}
            >
              <Toggle value="light">{t("Light")}</Toggle>
              <Toggle value="dark">{t("Dark")}</Toggle>
            </ToggleGroup>
          }
        />
        <LanguageSetting />
      </SettingsSection>
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {t("Could not save the theme.")}
        </p>
      ) : null}
    </SettingsPageContainer>
  );
}
