import { useMessages, msg } from "gt-react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";

import { DEFAULT_MOBILE_THEME_ID, type MobileThemeMode } from "../../lib/mobileTheme";
import { useAppearancePreferences } from "./appearance/AppearancePreferencesProvider";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { LanguageSettingsSection } from "./SettingsLanguageRouteScreen";
import { ToolCallsAppearanceSection } from "./appearance/sections/ToolCallsAppearanceSection";

export function PersonalSettingsRouteScreen() {
  const t = useMessages();
  const insets = useSafeAreaInsets();
  const { isReady, themeMode, setThemeIdForBothAppearances, setThemeMode } =
    useAppearancePreferences();
  const selectMode = (mode: MobileThemeMode) => {
    setThemeIdForBothAppearances(DEFAULT_MOBILE_THEME_ID);
    setThemeMode(mode);
  };
  const modes = [
    ["system", t(msg("System"))],
    ["light", t(msg("Light"))],
    ["dark", t(msg("Dark"))],
  ] as const;

  return (
    <SettingsScreen title={t(msg("Appearance"))}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          title={t(msg("Theme"))}
          footer={
            themeMode === "system"
              ? t(msg("Follows this device's light or dark setting."))
              : undefined
          }
        >
          {modes.map(([mode, label], index) => (
            <SettingsChoiceRow
              key={mode}
              label={label}
              selected={themeMode === mode}
              separated={index > 0}
              disabled={!isReady}
              onPress={() => selectMode(mode)}
            />
          ))}
        </SettingsSection>
        <LanguageSettingsSection />
        <ToolCallsAppearanceSection />
      </ScrollView>
    </SettingsScreen>
  );
}
