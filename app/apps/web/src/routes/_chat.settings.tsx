import { useTranslation } from "../i18n";

import { workspaceAreaProps } from "../lib/workspaceFocus";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { baskule } from "../baskule/flags"; // baskule:
import {
  firstBaskuleSettingsPath,
  isBaskuleOwnSettingsPage,
  isBaskuleSettingsPage,
} from "../baskule/settingsPages"; // baskule:
import { BaskuleSettingsNav, BaskuleSettingsTabs } from "../baskule/BaskuleSettingsNav"; // baskule:
import { useState, type ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useSettingsRestore } from "../components/settings/SettingsPanels";

import { AppRouteModal, AppRouteModalClose } from "../components/AppRouteModal";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { useEnvironments } from "../state/environments";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SETTINGS_DEVICE_ONLY_PATHS } from "../components/settings/SettingsScopeSentence";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  movedSettingsPath,
} from "../components/settings/settingsSearch";

function RestoreDeviceDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const t = useTranslation();
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      <span className="max-sm:sr-only">{t("Restore device defaults")}</span>
    </Button>
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const t = useTranslation();
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash);
  const autoSettlementAvailability = searchTarget?.requiresThreadAutoSettlement
    ? getThreadAutoSettlementSearchAvailability(environments, scope)
    : null;
  if (baskule.hideSettings && isBaskuleOwnSettingsPage(pathname)) return children;
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    autoSettlementAvailability &&
    !autoSettlementAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={autoSettlementAvailability.eligibleEnvironmentIds}
      >
        {autoSettlementAvailability.eligibleEnvironmentIds.length > 0
          ? t("{{title}} requires a supporting environment. Choose one to continue.", {
              title: searchTarget.title,
            })
          : t(
              "{{title}} requires a supporting environment. Connect or update an environment to continue.",
              { title: searchTarget.title },
            )}
      </SettingsScopeNotice>
    );
  }
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {t(
          "{{title}} is not available for the selected target. Choose its owning scope to continue.",
          { title: searchTarget.title },
        )}
      </SettingsScopeNotice>
    );
  }
  if (SETTINGS_DEVICE_ONLY_PATHS.has(pathname) || pathname === "/settings/projects") {
    return children;
  }
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">{scope.message}</p>
      </SettingsPageContainer>
    );
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {t("Reconnect")} {scope.label} {t("to change its settings.")}
        </p>
      </SettingsPageContainer>
    );
  }
  return children;
}

function SettingsContentLayout() {
  const t = useTranslation();
  const contentArea = workspaceAreaProps("settings", 1, "Settings content");
  const location = useLocation();
  const { search, environment } = useSettingsScope();
  const contentScopeKey =
    location.pathname === "/settings/diagnostics" || location.pathname === "/settings/providers"
      ? environment?.environmentId
      : JSON.stringify(search);
  const [restoreSignal, setRestoreSignal] = useState(0);

  return (
    <AppRouteModal label={t("Settings")}>
      <div className="relative flex min-h-0 flex-1">
        {/* baskule: the person's own sections replace T3's settings nav. */}
        {baskule.hideSettings ? (
          <BaskuleSettingsNav />
        ) : (
          <SettingsSidebarNav pathname={location.pathname} />
        )}
        <div {...contentArea} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2">
            {baskule.hideSettings ? (
              <span className="text-sm font-medium text-foreground">{t("Settings")}</span>
            ) : (
              <SettingsBreadcrumb pathname={location.pathname} />
            )}
            <div className="ms-auto flex shrink-0 items-center gap-1">
              {!baskule.hideSettings && location.pathname === "/settings/general" ? (
                <RestoreDeviceDefaultsButton
                  onRestored={() => setRestoreSignal((value) => value + 1)}
                />
              ) : null}
              <AppRouteModalClose />
            </div>
          </header>
          {baskule.hideSettings ? <BaskuleSettingsTabs /> : null}
          <div key={`${contentScopeKey}:${restoreSignal}`} className="min-h-0 flex flex-1 flex-col">
            <SettingsScopeBoundary pathname={location.pathname}>
              <Outlet />
            </SettingsScopeBoundary>
          </div>
        </div>
      </div>
    </AppRouteModal>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsScopeProvider
      search={rawSearch}
      singleEnvironment={pathname === "/settings/providers"}
      onChange={(next) => {
        // Send every axis so retain middleware recognizes "all" as an explicit target.
        void navigate({
          to: pathname,
          search: () => ({
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
          }),
          hash: "",
          resetScroll: false,
        });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({
        to: baskule.hideSettings ? firstBaskuleSettingsPath() : "/settings/general",
        replace: true,
      });
    }
    // baskule: only Baskule's settings pages are reachable; T3's moved-page links do not apply.
    if (baskule.hideSettings) {
      if (!isBaskuleSettingsPage(location.pathname)) throw redirect({ to: "/", replace: true });
      return;
    }
    const moved = movedSettingsPath(location.pathname, location.hash);
    if (moved) throw redirect({ to: moved, search: true, hash: true, replace: true });
  },
  component: SettingsRouteLayout,
});
