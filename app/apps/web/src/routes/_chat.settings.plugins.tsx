// baskule: the plugins a person may use, and the accounts they connect (hosted build).
import { createFileRoute } from "@tanstack/react-router";

import { UserPluginsView } from "../baskule/plugins/UserPluginsView";

export const Route = createFileRoute("/_chat/settings/plugins")({
  component: UserPluginsView,
});
