import { useTranslation } from "../../i18n";

import { LanguageSetting } from "./LanguageSetting";
import { Platform } from "react-native";
import { AndroidNavigationAppearanceSection } from "./appearance/sections/AndroidNavigationAppearanceSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";
import { BASKULE_FLAGS } from "../../baskule/flags";
import { PersonalSettingsRouteScreen } from "./PersonalSettingsRouteScreen";

export function SettingsAppearanceRouteScreen() {
  return BASKULE_FLAGS.extendedSettings ? (
    <UpstreamAppearanceSettings />
  ) : (
    <PersonalSettingsRouteScreen />
  );
}

function UpstreamAppearanceSettings() {
  const t = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title={t("Appearance")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <LanguageSetting />
        <ThemeAppearanceSection />
        {Platform.OS === "android" ? <AndroidNavigationAppearanceSection /> : null}
        <TextAppearanceSection />
        <TerminalAppearanceSection />
        <CodeAppearanceSection />
      </ScrollView>
    </SettingsScreen>
  );
}
