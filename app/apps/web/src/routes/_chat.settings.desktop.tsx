// baskule: Settings → Desktop app (hosted build).
import { createFileRoute } from "@tanstack/react-router";

import { DownloadsView } from "../baskule/views/DownloadsView";

export const Route = createFileRoute("/_chat/settings/desktop")({ component: DownloadsView });
