import { useTranslation } from "../../i18n";
// baskule: the admin modal's nav, like the settings nav: one group per section, one row per page,
// an icon rail below md.
import { Link, useParams } from "@tanstack/react-router";

import { Badge } from "../../components/ui/badge";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../../components/ui/sidebar";
import { useBaskuleMe } from "../session";
import { adminSections } from "./navigation";

export function AdminSidebarNav() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const current = useParams({ strict: false });
  return (
    <nav
      aria-label={t("Admin")}
      className="flex w-60 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground max-md:w-14"
    >
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <div className="flex flex-col gap-4">
            {adminSections(me).map((section) => (
              <div
                key={section.id}
                role="group"
                aria-label={t(section.label)}
                className="flex flex-col gap-1 max-md:border-t max-md:border-sidebar-border max-md:pt-4 max-md:first:border-t-0 max-md:first:pt-0"
              >
                <h3 className="px-2 text-xs font-medium text-sidebar-muted-foreground/80 max-md:hidden">
                  {t(section.label)}
                </h3>
                <SidebarMenu>
                  {section.pages.map((page) => (
                    <SidebarMenuItem key={page.id}>
                      <SidebarMenuButton
                        isActive={current.section === section.id && current.page === page.id}
                        render={
                          <Link
                            to="/admin/$section/$page"
                            params={{ section: section.id, page: page.id }}
                          />
                        }
                      >
                        <page.icon />
                        <span className="min-w-0 flex-1 truncate max-md:sr-only">
                          {t(page.label)}
                        </span>
                        {page.component ? null : (
                          <span className="max-md:hidden">
                            <Badge variant="secondary" size="sm">
                              {t("Soon")}
                            </Badge>
                          </span>
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </div>
            ))}
          </div>
        </SidebarGroup>
      </SidebarContent>
    </nav>
  );
}
