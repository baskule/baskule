import { useTranslation } from "../../i18n";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";

import { DEFAULT_MOBILE_THEME_ID } from "../../lib/mobileTheme";
import { useAppearancePreferences } from "./appearance/AppearancePreferencesProvider";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { LanguageSetting } from "./LanguageSetting";

export function PersonalSettingsRouteScreen() {
  const t = useTranslation();
  const insets = useSafeAreaInsets();
  const { themeAppearance, setThemeIdForBothAppearances, setThemeMode } =
    useAppearancePreferences();
  const selectAppearance = (appearance: "light" | "dark") => {
    setThemeIdForBothAppearances(DEFAULT_MOBILE_THEME_ID);
    setThemeMode(appearance);
  };

  return (
    <SettingsScreen title={t("General")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={t("Appearance")}>
          <SettingsChoiceRow
            label={t("Light")}
            selected={themeAppearance === "light"}
            onPress={() => selectAppearance("light")}
          />
          <SettingsChoiceRow
            label={t("Dark")}
            selected={themeAppearance === "dark"}
            separated
            onPress={() => selectAppearance("dark")}
          />
        </SettingsSection>
        <LanguageSetting />
      </ScrollView>
    </SettingsScreen>
  );
}
