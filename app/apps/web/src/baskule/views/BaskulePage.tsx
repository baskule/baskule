// baskule: building blocks of the Baskule pages in the admin and settings modals.
import type { ReactNode } from "react";

/** A page's title block under its frame's header; detail pages pass their item's tile and controls. */
export function PageHeading({
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
