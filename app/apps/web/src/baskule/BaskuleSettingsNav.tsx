import { useTranslation } from "../i18n";
// baskule: the Settings modal's section nav and page heading. Like the admin nav, a rail of labelled
// rows; below md, a row of labelled tabs under the header instead of an icon-only rail.
import { Link, useLocation, useMatch } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../components/ui/sidebar";
import { cn } from "../lib/utils";
import { useBaskuleMe } from "./session";
import { baskuleSettingsSection, baskuleSettingsSections } from "./settingsPages";
import { PageHeading } from "./views/BaskulePage";

function useSections() {
  const me = useBaskuleMe();
  const pathname = useLocation({ select: (location) => location.pathname });
  return { sections: baskuleSettingsSections(me), pathname };
}

export function BaskuleSettingsNav() {
  const t = useTranslation();
  const { sections, pathname } = useSections();
  return (
    <nav
      aria-label={t("Settings sections")}
      className="flex w-60 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground max-md:hidden"
    >
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <SidebarMenu>
            {sections.map((section) => (
              <SidebarMenuItem key={section.path}>
                <SidebarMenuButton
                  isActive={pathname === section.path}
                  render={<Link to={section.path} />}
                >
                  <section.icon />
                  <span className="min-w-0 flex-1 truncate">{t(section.label)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </nav>
  );
}

export function BaskuleSettingsTabs() {
  const t = useTranslation();
  const { sections, pathname } = useSections();
  return (
    <nav
      aria-label={t("Settings sections")}
      className="shrink-0 overflow-x-auto border-b [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
    >
      <ul className="flex w-max gap-1 px-3 py-2">
        {sections.map((section) => {
          const active = pathname === section.path;
          return (
            <li key={section.path}>
              <Link
                to={section.path}
                aria-current={active ? "page" : undefined}
                // The current tab may sit past the screen edge after a link opened it.
                ref={
                  active
                    ? (node) => node?.scrollIntoView({ block: "nearest", inline: "nearest" })
                    : undefined
                }
                className={cn(
                  "flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
                  active
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <section.icon aria-hidden />
                {t(section.label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The current section's title and purpose, at the top of its page. */
export function BaskuleSettingsHeading() {
  const t = useTranslation();
  // The page on screen, not the location: a lazily loaded next page leaves this one up until it loads.
  const pathname = useMatch({
    strict: false,
    shouldThrow: false,
    select: (match) => match.pathname,
  });
  const section = pathname === undefined ? null : baskuleSettingsSection(pathname);
  return section ? (
    <PageHeading title={t(section.label)} description={t(section.description)} />
  ) : null;
}
