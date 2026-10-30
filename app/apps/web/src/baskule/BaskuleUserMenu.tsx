import { useTranslation } from "../i18n";

// baskule: the signed-in person in the sidebar footer: their Settings, the admin area for admins,
// and sign out.
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, LogOutIcon, SettingsIcon, ShieldIcon } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { SidebarMenuButton, useSidebar } from "../components/ui/sidebar";
import { signOutBaskule, useBaskuleMe } from "./session";
import { Avatar } from "./ui";

export function BaskuleUserMenu() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (me === null) return null;
  const open = (to: "/settings" | "/admin") => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to });
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            aria-label={t("Account: {{name}}", { name: me.user.name })}
            data-testid="baskule-user-menu"
          />
        }
      >
        <Avatar name={me.user.name} className="size-6" />
        <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
          <span className="truncate text-sm">{me.user.name}</span>
          <span className="truncate text-2xs text-muted-foreground">
            {me.authentication.mode === "anonymous" ? t("Shared test workspace") : me.user.email}
          </span>
        </span>
        <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup side="top" align="start" className="min-w-60">
        <MenuItem onClick={() => open("/settings")}>
          <SettingsIcon />
          {t("Settings")}
        </MenuItem>
        {me.user.role === "admin" ? (
          <MenuItem onClick={() => open("/admin")}>
            <ShieldIcon />
            {t("Admin")}
          </MenuItem>
        ) : null}
        {me.authentication.mode !== "anonymous" ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => void signOutBaskule()}>
              <LogOutIcon />
              {t("Sign out")}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
