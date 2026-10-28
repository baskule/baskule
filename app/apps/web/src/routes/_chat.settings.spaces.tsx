import { createFileRoute } from "@tanstack/react-router";
import { SpacesSettingsView } from "../baskule/views/SpacesSettingsView";

export const Route = createFileRoute("/_chat/settings/spaces")({ component: SpacesSettingsView });
