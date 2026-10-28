import { createFileRoute } from "@tanstack/react-router";
import { AccountSettingsView } from "../baskule/views/AccountSettingsView";

export const Route = createFileRoute("/_chat/settings/account")({ component: AccountSettingsView });
