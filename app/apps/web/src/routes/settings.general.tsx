import { createFileRoute } from "@tanstack/react-router";

import { GeneralSettingsPanel } from "../components/settings/SettingsPanels";
import { baskule } from "../baskule/flags";
import { PersonalSettingsView } from "../baskule/views/PersonalSettingsView";

function SettingsGeneralRoute() {
  return baskule.hideSettings ? <PersonalSettingsView /> : <GeneralSettingsPanel />;
}

export const Route = createFileRoute("/settings/general")({
  component: SettingsGeneralRoute,
});
