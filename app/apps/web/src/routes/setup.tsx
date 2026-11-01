// baskule: one-time setup link of a new hosted installation (`/setup#token=…`).
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { baskule } from "../baskule/flags";
import { tokenFromHash } from "../baskule/views/InvitationView";
import { SetupView } from "../baskule/views/SetupView";

export const Route = createFileRoute("/setup")({
  beforeLoad: () => {
    if (!baskule.hosted) throw redirect({ to: "/", replace: true });
  },
  component: SetupRouteView,
});

function SetupRouteView() {
  // Read once: the view removes the token from the address bar.
  const [token] = useState(() => tokenFromHash(window.location.hash));
  return <SetupView token={token} />;
}
