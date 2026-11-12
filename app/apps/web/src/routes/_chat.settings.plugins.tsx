// baskule: the plugins a person may use, their switches and sign-ins (hosted build).
import { createFileRoute } from "@tanstack/react-router";

import { MemberPluginsView } from "../baskule/plugins/MemberPluginsView";

export const Route = createFileRoute("/_chat/settings/plugins")({
  component: MemberPluginsView,
});
