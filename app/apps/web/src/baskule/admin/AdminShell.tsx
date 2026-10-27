// baskule: frame of the admin area: the admin-only guard, the page heading, the phone section
// list (the sidebar holds the same list on wider screens) and the placeholder of pages in progress.
import { Link, Navigate, Outlet } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Suspense, type ReactNode } from "react";

import { useTranslation } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Spinner } from "../../components/ui/spinner";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useBaskuleMe } from "../session";
import { RowIcon } from "../ui";
import { BaskulePage, PageMessage, PageSection } from "../views/BaskulePage";
import { adminSections, findAdminPage, type AdminPage, type AdminSection } from "./navigation";

export function AdminLayout() {
  const t = useTranslation();
  const me = useBaskuleMe();
  if (me !== null && me.user.role !== "admin") {
    return (
      <BaskulePage title={t("Admin")}>
        <Alert variant="error">
          <AlertDescription>{t("Only administrators can open the admin panel.")}</AlertDescription>
        </Alert>
      </BaskulePage>
    );
  }
  return <Outlet />;
}

/** `/admin`: the first page on wide screens, the list of every page on a phone. */
export function AdminHome() {
  const t = useTranslation();
  const me = useBaskuleMe();
  const isMobile = useIsMobile();
  const sections = adminSections(me);
  const [first] = sections;
  if (!isMobile && first?.pages[0]) {
    return (
      <Navigate
        to="/admin/$section/$page"
        params={{ section: first.id, page: first.pages[0].id }}
        replace
      />
    );
  }
  return (
    <BaskulePage title={t("Admin")}>
      {sections.map((section) => (
        <PageSection key={section.id} title={t(section.label)}>
          {section.pages.map((page) => (
            <Link
              key={page.id}
              to="/admin/$section/$page"
              params={{ section: section.id, page: page.id }}
              className="flex min-h-14 items-center gap-3 px-3 py-2.5 outline-hidden hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
            >
              <RowIcon>
                <page.icon />
              </RowIcon>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm text-foreground">{t(page.label)}</span>
                <span className="text-xs text-muted-foreground">{t(page.description)}</span>
              </span>
              {page.component ? null : (
                <Badge variant="secondary" size="sm">
                  {t("Soon")}
                </Badge>
              )}
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </PageSection>
      ))}
    </BaskulePage>
  );
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
  const me = useBaskuleMe();
  // Until the session is known, anonymous-only filtering cannot run: wait rather than bounce.
  if (me === null) return <AdminFrame />;
  const found = findAdminPage(me, sectionId, pageId);
  if (!found) return <Navigate to="/admin" replace />;
  if (itemId !== undefined && !found.page.detail) {
    return (
      <Navigate to="/admin/$section/$page" params={{ section: sectionId, page: pageId }} replace />
    );
  }
  return <AdminFrame found={found} {...(itemId === undefined ? {} : { itemId })} />;
}

function AdminFrame({
  found,
  itemId,
}: {
  readonly found?: { readonly section: AdminSection; readonly page: AdminPage };
  readonly itemId?: string;
}) {
  const t = useTranslation();
  const Page = found?.page.component;
  const Detail = itemId === undefined ? undefined : found?.page.detail;
  return (
    <BaskulePage
      breadcrumb={
        <WorkspaceBreadcrumb ariaLabel={t("Admin breadcrumb")}>
          <WorkspaceBreadcrumbItem>
            <Link to="/admin" className={BREADCRUMB_LINK}>
              <WorkspaceBreadcrumbText>{t("Admin")}</WorkspaceBreadcrumbText>
            </Link>
          </WorkspaceBreadcrumbItem>
          {found ? (
            <>
              <WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbSeparator>
              {Detail ? (
                <WorkspaceBreadcrumbItem className="truncate">
                  <Link
                    to="/admin/$section/$page"
                    params={{ section: found.section.id, page: found.page.id }}
                    className={BREADCRUMB_LINK}
                  >
                    <WorkspaceBreadcrumbText>
                      {t(found.section.label)} · {t(found.page.label)}
                    </WorkspaceBreadcrumbText>
                  </Link>
                </WorkspaceBreadcrumbItem>
              ) : (
                <WorkspaceBreadcrumbItem className="truncate text-foreground">
                  <WorkspaceBreadcrumbText>{t(found.section.label)}</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbItem>
              )}
            </>
          ) : null}
        </WorkspaceBreadcrumb>
      }
    >
      {found && Detail && itemId !== undefined ? (
        // A detail page names its item itself: only it knows the item's name.
        <Suspense fallback={<Loading />}>
          <Detail key={itemId} id={itemId} />
        </Suspense>
      ) : found ? (
        <>
          <AdminPageHeading title={t(found.page.label)} description={t(found.page.description)} />
          {Page ? (
            <Suspense fallback={<Loading />}>
              <Page />
            </Suspense>
          ) : (
            <AdminPlaceholder page={found.page} />
          )}
        </>
      ) : (
        <Loading />
      )}
    </BaskulePage>
  );
}

const BREADCRUMB_LINK =
  "rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

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
