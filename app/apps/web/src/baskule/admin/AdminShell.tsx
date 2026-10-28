// baskule: frame of the admin area, a modal over the chat that opened it like Settings: the admin-only
// guard, the section nav, the breadcrumb and close button, and the placeholder of pages in progress.
import { Link, Navigate, Outlet, useParams } from "@tanstack/react-router";
import { Suspense, type ReactNode } from "react";

import { useTranslation } from "../../i18n";
import { AppRouteModal, AppRouteModalClose } from "../../components/AppRouteModal";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Spinner } from "../../components/ui/spinner";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../../components/WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { useBaskuleMe } from "../session";
import { RowIcon } from "../ui";
import { PageMessage } from "../views/BaskulePage";
import { AdminSidebarNav } from "./AdminSidebarNav";
import { adminSections, findAdminPage, type AdminPage } from "./navigation";

export function AdminLayout() {
  const t = useTranslation();
  const me = useBaskuleMe();
  // Until the session is known, show the frame rather than a refusal.
  const allowed = me === null || me.user.role === "admin";
  return (
    <AppRouteModal label={t("Admin")}>
      <div className="relative flex min-h-0 flex-1">
        {allowed ? <AdminSidebarNav /> : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2">
            <AdminBreadcrumb />
            <div className="ms-auto flex shrink-0 items-center gap-1">
              <AppRouteModalClose />
            </div>
          </header>
          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="wide" className="gap-8">
              {allowed ? (
                <Outlet />
              ) : (
                <Alert variant="error">
                  <AlertDescription>
                    {t("Only administrators can open the admin panel.")}
                  </AlertDescription>
                </Alert>
              )}
            </WorkspacePageContainer>
          </div>
        </div>
      </div>
    </AppRouteModal>
  );
}

function AdminBreadcrumb() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const { section, page, item } = useParams({ strict: false });
  const found =
    section === undefined || page === undefined ? null : findAdminPage(me, section, page);
  return (
    <WorkspaceBreadcrumb ariaLabel={t("Admin breadcrumb")}>
      {found ? (
        <>
          <WorkspaceBreadcrumbItem>{t("Admin")}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          {item !== undefined && found.page.detail ? (
            <WorkspaceBreadcrumbItem className="truncate">
              <Link
                to="/admin/$section/$page"
                params={{ section: found.section.id, page: found.page.id }}
                className={BREADCRUMB_LINK}
              >
                {t(found.section.label)} · {t(found.page.label)}
              </Link>
            </WorkspaceBreadcrumbItem>
          ) : (
            <WorkspaceBreadcrumbItem current className="truncate">
              {t(found.section.label)}
            </WorkspaceBreadcrumbItem>
          )}
        </>
      ) : (
        <WorkspaceBreadcrumbItem current>{t("Admin")}</WorkspaceBreadcrumbItem>
      )}
    </WorkspaceBreadcrumb>
  );
}

/** `/admin`: the first page; the nav lists the others. */
export function AdminHome() {
  const me = useBaskuleMe();
  const first = adminSections(me)[0];
  return first?.pages[0] ? (
    <Navigate
      to="/admin/$section/$page"
      params={{ section: first.id, page: first.pages[0].id }}
      replace
    />
  ) : null;
}

/** `/admin/$section`: the section's first page. */
export function AdminSectionHome({ sectionId }: { readonly sectionId: string }) {
  const me = useBaskuleMe();
  const first = adminSections(me).find((section) => section.id === sectionId)?.pages[0];
  return first ? (
    <Navigate to="/admin/$section/$page" params={{ section: sectionId, page: first.id }} replace />
  ) : (
    <Navigate to="/admin" replace />
  );
}

export function AdminPageView({
  sectionId,
  pageId,
  itemId,
}: {
  readonly sectionId: string;
  readonly pageId: string;
  readonly itemId?: string;
}) {
  const t = useTranslation();
  const me = useBaskuleMe();
  // Until the session is known, anonymous-only filtering cannot run: wait rather than bounce.
  if (me === null) return <Loading />;
  const found = findAdminPage(me, sectionId, pageId);
  if (!found) return <Navigate to="/admin" replace />;
  const { page } = found;
  if (itemId !== undefined) {
    if (!page.detail) {
      return (
        <Navigate
          to="/admin/$section/$page"
          params={{ section: sectionId, page: pageId }}
          replace
        />
      );
    }
    // A detail page names its item itself: only it knows the item's name.
    return (
      <Suspense fallback={<Loading />}>
        <page.detail key={itemId} id={itemId} />
      </Suspense>
    );
  }
  return (
    <>
      <AdminPageHeading title={t(page.label)} description={t(page.description)} />
      {page.component ? (
        <Suspense fallback={<Loading />}>
          <page.component />
        </Suspense>
      ) : (
        <AdminPlaceholder page={page} />
      )}
    </>
  );
}

const BREADCRUMB_LINK =
  "rounded-sm transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The page title block; detail pages pass their item's tile and controls. */
export function AdminPageHeading({
  title,
  description,
  leading,
  trailing,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  /** More text under the description, in the same column as the title. */
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3 sm:px-4">
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="text-lg font-medium text-foreground [overflow-wrap:anywhere]">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        {children}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-2 pt-0.5">{trailing}</div> : null}
    </div>
  );
}

function Loading() {
  return (
    <PageMessage>
      <Spinner size="sm" tone="muted" />
    </PageMessage>
  );
}

function AdminPlaceholder({ page }: { readonly page: AdminPage }) {
  const t = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <RowIcon>
        <page.icon />
      </RowIcon>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{t("Coming in this release")}</p>
        <p className="text-xs text-muted-foreground">{t("Nothing to set up here yet.")}</p>
      </div>
    </div>
  );
}
