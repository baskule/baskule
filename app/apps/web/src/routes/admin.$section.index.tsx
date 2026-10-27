// baskule:
import { createFileRoute } from "@tanstack/react-router";

import { AdminSectionHome } from "../baskule/admin/AdminShell";

export const Route = createFileRoute("/admin/$section/")({
  component: AdminSectionRoute,
});

function AdminSectionRoute() {
  const { section } = Route.useParams();
  return <AdminSectionHome sectionId={section} />;
}
