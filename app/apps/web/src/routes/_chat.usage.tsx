import { createFileRoute, redirect } from "@tanstack/react-router";
import { baskule } from "../baskule/flags"; // baskule:

import { UsagePage } from "../components/usage/UsagePage";

export const Route = createFileRoute("/_chat/usage")({
  beforeLoad: () => {
    // baskule: page not part of the Baskule UI.
    if (baskule.hideSettings) throw redirect({ to: "/", replace: true });
  },
  component: UsagePage,
});
