// baskule: one item of an admin list (an installed plugin, a group).
import { createFileRoute } from "@tanstack/react-router";

import { AdminPageView } from "../baskule/admin/AdminShell";

export const Route = createFileRoute("/_chat/admin/$section/$page_/$item")({
  component: AdminItemRoute,
});

function AdminItemRoute() {
  const { section, page, item } = Route.useParams();
  return <AdminPageView sectionId={section} pageId={page} itemId={item} />;
}
