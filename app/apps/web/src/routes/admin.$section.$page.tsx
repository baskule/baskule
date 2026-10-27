// baskule:
import { createFileRoute } from "@tanstack/react-router";

import { AdminPageView } from "../baskule/admin/AdminShell";

export const Route = createFileRoute("/admin/$section/$page")({
  component: AdminPageRoute,
});

function AdminPageRoute() {
  const { section, page } = Route.useParams();
  return <AdminPageView sectionId={section} pageId={page} />;
}
