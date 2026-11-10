import { createFileRoute, redirect } from "@tanstack/react-router";

// Older clients and saved links may still navigate to the retired first-run wizard.
export const Route = createFileRoute("/welcome")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
