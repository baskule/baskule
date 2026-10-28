// baskule: frame of the Baskule in-app pages (downloads), matching the settings pages.
import type { ReactNode } from "react";

import { SidebarInset } from "../../components/ui/sidebar";
import { WorkspacePageContainer } from "../../components/WorkspacePageContainer";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";

export function BaskulePage({
  title,
  breadcrumb,
  actions,
  children,
}: (
  | { readonly title: string; readonly breadcrumb?: never }
  | { readonly breadcrumb: ReactNode; readonly title?: never }
) & {
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            {breadcrumb ?? (
              <h1 className="truncate text-sm font-medium text-foreground">{title}</h1>
            )}
            {actions ? (
              <div className="ms-auto flex shrink-0 items-center gap-2">{actions}</div>
            ) : null}
          </div>
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto">
          <WorkspacePageContainer width="wide" className="gap-8">
            {children}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

/** A titled group of rows, like a settings section. */
export function PageSection({
  title,
  description,
  action,
  children,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex min-h-7 items-end justify-between gap-4 px-3 sm:px-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-normal text-foreground/70">{title}</h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <div className="relative rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50">
        {children}
      </div>
    </section>
  );
}

/** One row of a section: leading content, then trailing controls. */
export function PageRow({
  leading,
  children,
  trailing,
  muted = false,
}: {
  readonly leading?: ReactNode;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <div
      className={
        muted
          ? "flex min-h-14 items-center gap-3 px-3 py-2.5 opacity-70 sm:px-4"
          : "flex min-h-14 items-center gap-3 px-3 py-2.5 sm:px-4"
      }
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
      {trailing ? <div className="flex shrink-0 items-center gap-1.5">{trailing}</div> : null}
    </div>
  );
}

export function PageMessage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="px-3 py-6 text-center text-sm text-muted-foreground sm:px-4">{children}</div>
  );
}
