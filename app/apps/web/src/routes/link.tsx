// baskule: connection link of the hosted multi-user build (`/link#code=…`).
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { baskuleManagementDestination } from "@t3tools/contracts/baskule";

import { codeFromHash } from "../baskule/connect";
import { baskule } from "../baskule/flags";
import { ConnectLinkView } from "../baskule/views/ConnectLinkView";

export const Route = createFileRoute("/link")({
  beforeLoad: () => {
    if (!baskule.hosted) throw redirect({ to: "/", replace: true });
  },
  component: ConnectLinkRouteView,
});

function ConnectLinkRouteView() {
  const [target] = useState(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return {
      code: codeFromHash(window.location.hash),
      destination: baskuleManagementDestination(hash.get("destination")) ?? "/",
    } as const;
  });
  return <ConnectLinkView code={target.code} destination={target.destination} />;
}
