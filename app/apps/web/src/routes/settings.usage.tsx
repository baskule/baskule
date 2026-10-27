import { createFileRoute, redirect } from "@tanstack/react-router";

import { baskule } from "../baskule/flags";
import { MyUsagePage } from "../baskule/usage/MyUsagePage";

// baskule: the signed-in person's usage and limits; T3's own usage page is `/usage`.
export const Route = createFileRoute("/settings/usage")({
  beforeLoad: () => {
    if (!baskule.hosted) throw redirect({ to: "/usage", replace: true });
  },
  component: MyUsagePage,
});
