// baskule: invitation link of the hosted multi-user build (`/invite#token=…`).
import { createFileRoute, redirect, useLocation } from "@tanstack/react-router";

import { baskule } from "../baskule/flags";
import { InvitationView, tokenFromHash } from "../baskule/views/InvitationView";

export const Route = createFileRoute("/invite")({
  beforeLoad: () => {
    if (!baskule.hosted) throw redirect({ to: "/", replace: true });
  },
  component: InvitationRouteView,
});

function InvitationRouteView() {
  const hash = useLocation({ select: (location) => location.hash });
  const token = tokenFromHash(hash || window.location.hash);
  return <InvitationView key={token ?? ""} token={token} />;
}
