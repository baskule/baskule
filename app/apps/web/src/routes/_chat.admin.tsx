// baskule: admin area of the hosted multi-user build; its pages are listed in baskule/admin/navigation.
import { createFileRoute, redirect } from "@tanstack/react-router";

import { AdminLayout } from "../baskule/admin/AdminShell";
import { baskule } from "../baskule/flags";

export const Route = createFileRoute("/_chat/admin")({
  beforeLoad: () => {
    if (!baskule.hosted) throw redirect({ to: "/", replace: true });
  },
  component: AdminLayout,
});
