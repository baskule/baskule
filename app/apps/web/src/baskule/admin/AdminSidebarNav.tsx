// baskule: the app sidebar on admin pages: one group per section, one row per page.
import { Link, useParams } from "@tanstack/react-router";

import { useTranslation } from "../../i18n";
import { SidebarUtilityMenu } from "../../components/sidebar/SidebarChrome";
import { Badge } from "../../components/ui/badge";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../../components/ui/sidebar";
import { useBaskuleMe } from "../session";
import { adminSections } from "./navigation";

export function AdminSidebarNav() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const current = useParams({ strict: false });
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        {adminSections(me).map((section) => (
          <SidebarGroup key={section.id} role="group" aria-labelledby={`admin-nav-${section.id}`}>
            <h2
              id={`admin-nav-${section.id}`}
              className="px-2.5 pb-1 text-xs font-medium text-sidebar-muted-foreground"
            >
              {t(section.label)}
            </h2>
            <SidebarMenu>
              {section.pages.map((page) => (
                <SidebarMenuItem key={page.id}>
                  <SidebarMenuButton
                    isActive={current.section === section.id && current.page === page.id}
                    render={
                      <Link
                        to="/admin/$section/$page"
                        params={{ section: section.id, page: page.id }}
                        onClick={() => {
                          if (isMobile) setOpenMobile(false);
                        }}
                      />
                    }
                  >
                    <page.icon />
                    <span className="min-w-0 flex-1 truncate">{t(page.label)}</span>
                    {page.component ? null : (
                      <Badge variant="secondary" size="sm">
                        {t("Soon")}
                      </Badge>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarUtilityMenu />
      </SidebarFooter>
    </>
  );
}
