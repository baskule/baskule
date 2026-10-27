import { useTranslation } from "../i18n";
// baskule: the signed-in person in the sidebar footer: spaces they own, settings, plugins, apps,
// admin, sign out.
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  BlocksIcon,
  ChartNoAxesColumnIcon,
  ChevronsUpDownIcon,
  DownloadIcon,
  KeyRoundIcon,
  LogOutIcon,
  SettingsIcon,
  PlusIcon,
  ShieldIcon,
  UsersIcon,
} from "lucide-react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { SidebarMenuButton, useSidebar } from "../components/ui/sidebar";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { openCreateSpace, openSpaceManagement } from "./SpaceManagementDialog";
import { signOutBaskule, useBaskuleMe } from "./session";
import { Avatar } from "./ui";

export function BaskuleUserMenu() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [changingPassword, setChangingPassword] = useState(false);
  if (me === null) return null;
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const isAdmin = me.user.role === "admin";
  const managedSpaces = me.spaces.filter(
    (space) => space.kind === "team" && (space.role === "owner" || isAdmin),
  );

  return (
    <>
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
          {managedSpaces.length > 0 ? (
            <MenuGroup>
              <MenuGroupLabel>{t("Spaces you manage")}</MenuGroupLabel>
              {managedSpaces.map((space) => (
                <MenuItem
                  key={space.id}
                  onClick={() => {
                    closeMobile();
                    openSpaceManagement(space.id);
                  }}
                >
                  <UsersIcon />
                  {space.name}
                </MenuItem>
              ))}
            </MenuGroup>
          ) : null}
          {me.canCreateSpaces || isAdmin ? (
            <MenuItem
              onClick={() => {
                closeMobile();
                openCreateSpace();
              }}
            >
              <PlusIcon />
              {t("New team space")}
            </MenuItem>
          ) : null}
          {managedSpaces.length > 0 || me.canCreateSpaces || isAdmin ? <MenuSeparator /> : null}
          {isAdmin ? (
            <MenuItem
              onClick={() => {
                closeMobile();
                void navigate({ to: "/admin" });
              }}
            >
              <ShieldIcon />
              {t("Admin")}
            </MenuItem>
          ) : null}
          <MenuItem
            onClick={() => {
              closeMobile();
              void navigate({ to: "/settings/general" });
            }}
          >
            <SettingsIcon />
            {t("Settings")}
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeMobile();
              void navigate({ to: "/settings/usage" });
            }}
          >
            <ChartNoAxesColumnIcon />
            {t("Usage")}
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeMobile();
              void navigate({ to: "/settings/plugins" });
            }}
          >
            <BlocksIcon />
            {t("Plugins")}
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeMobile();
              void navigate({ to: "/apps" });
            }}
          >
            <DownloadIcon />
            {t("Desktop app")}
          </MenuItem>
          {window.desktopBridge?.connectBaskuleServer ? (
            <MenuItem
              onClick={() => {
                closeMobile();
                window.location.assign("/login?server=1");
              }}
            >
              <SettingsIcon />
              {t("Connect to a server")}
            </MenuItem>
          ) : null}
          <MenuSeparator />
          {me.authentication.password ? (
            <MenuItem
              // The dialog lives in this component: keep the phone drawer (and it) mounted.
              onClick={() => setChangingPassword(true)}
            >
              <KeyRoundIcon />
              {t("Change password")}
            </MenuItem>
          ) : null}
          {me.authentication.mode !== "anonymous" ? (
            <MenuItem onClick={() => void signOutBaskule()}>
              <LogOutIcon />
              {t("Sign out")}
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      <ChangePasswordDialog open={changingPassword} onOpenChange={setChangingPassword} />
    </>
  );
}
