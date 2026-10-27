import { useTranslation } from "../i18n";
// baskule: shown while none of the person's spaces has answered yet (cells waking up), and
// when the server can't be reached at all.
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

const SLOW_AFTER_MS = 15_000;

export function BaskuleSpacesPending() {
  const t = useTranslation();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} />
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          {slow ? null : <Spinner size="lg" tone="muted" className="mx-auto mb-3" />}
          <EmptyTitle>
            {slow ? t("Your spaces are not answering") : t("Opening your spaces…")}
          </EmptyTitle>
          <EmptyDescription>
            {slow
              ? t("The server may be restarting. This page keeps trying; you can also reload it.")
              : t("This takes a few seconds when a space was asleep.")}
          </EmptyDescription>
          {slow ? (
            <div className="mt-5 flex justify-center">
              <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                {t("Reload")}
              </Button>
            </div>
          ) : null}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
