// baskule: one-time setup link of a new hosted installation (`/setup#token=…`).
import { createFileRoute, redirect } from "@tanstack/react-router";

import { baskule } from "../baskule/flags";
import { SetupView } from "../baskule/views/SetupView";

export const Route = createFileRoute("/setup")({
  beforeLoad: () => {
    if (!baskule.hosted) throw redirect({ to: "/", replace: true });
  },
  component: SetupView,
});
