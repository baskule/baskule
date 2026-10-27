// baskule: desktop and mobile apps of the hosted multi-user build. Not `/downloads`: the
// front serves the app files themselves under `/downloads/` (E10).
import { createFileRoute, redirect } from "@tanstack/react-router";

import { baskule } from "../baskule/flags";
import { DownloadsView } from "../baskule/views/DownloadsView";

export const Route = createFileRoute("/apps")({
  beforeLoad: () => {
    if (!baskule.hosted) throw redirect({ to: "/", replace: true });
  },
  component: DownloadsView,
});
