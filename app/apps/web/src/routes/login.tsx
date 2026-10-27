// baskule: sign-in page of the hosted multi-user build.
import { createFileRoute, redirect } from "@tanstack/react-router";

import { baskule } from "../baskule/flags";
import { LoginView } from "../baskule/views/LoginView";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === "string" ? { next: search.next } : {},
  beforeLoad: () => {
    if (!baskule.hosted) throw redirect({ to: "/", replace: true });
  },
  component: LoginRouteView,
});

function LoginRouteView() {
  const { next } = Route.useSearch();
  return <LoginView next={next ?? null} />;
}
