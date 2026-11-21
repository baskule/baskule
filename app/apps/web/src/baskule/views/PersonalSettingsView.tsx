import { useMessages, msg } from "gt-react";

import { useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import {
  LanguageSettingsRow,
  ScreenReaderAnnouncementsRow,
  ScreenReaderWindowTitleRow,
  ToolCallVisibilityRow,
} from "../../components/settings/SettingsPanels";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";

export function PersonalSettingsView() {
  const t = useMessages();
  const { resolvedTheme, setAppearanceMode, setTheme } = useTheme();
  const [error, setError] = useState(false);

  return (
    <SettingsPageContainer>
      <SettingsSection title={t(msg("Language & appearance"))} hideTitle>
        <SettingsRow
          title={t(msg("Appearance"))}
          control={
            <ToggleGroup
              aria-label={t(msg("Appearance"))}
              value={[resolvedTheme]}
              onValueChange={(values) => {
                const appearance = values[0] ?? resolvedTheme;
                if (appearance === "light" || appearance === "dark") {
                  setError(!setTheme("system") || !setAppearanceMode(appearance));
                }
              }}
            >
              <Toggle value="light">{t(msg("Light"))}</Toggle>
              <Toggle value="dark">{t(msg("Dark"))}</Toggle>
            </ToggleGroup>
          }
        />
        <LanguageSettingsRow />
      </SettingsSection>
      <SettingsSection title={t(msg("Chats"))}>
        <ToolCallVisibilityRow />
        <ScreenReaderAnnouncementsRow />
        <ScreenReaderWindowTitleRow />
      </SettingsSection>
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {t(msg("Could not save the theme."))}
        </p>
      ) : null}
    </SettingsPageContainer>
  );
}
