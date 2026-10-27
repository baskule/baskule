// baskule:
import { createFileRoute } from "@tanstack/react-router";

import { AdminHome } from "../baskule/admin/AdminShell";

export const Route = createFileRoute("/admin/")({
  component: AdminHome,
});
