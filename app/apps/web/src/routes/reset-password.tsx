// baskule: password reset link of the hosted multi-user build (`/reset-password#token=…`).
import { createFileRoute, redirect, useLocation } from "@tanstack/react-router";

import { baskule } from "../baskule/flags";
import { tokenFromHash } from "../baskule/views/InvitationView";
import { ResetPasswordView } from "../baskule/views/ResetPasswordView";

export const Route = createFileRoute("/reset-password")({
  beforeLoad: () => {
    if (!baskule.hosted) throw redirect({ to: "/", replace: true });
  },
  component: ResetPasswordRouteView,
});

function ResetPasswordRouteView() {
  const hash = useLocation({ select: (location) => location.hash });
  return <ResetPasswordView token={tokenFromHash(hash || window.location.hash)} />;
}
