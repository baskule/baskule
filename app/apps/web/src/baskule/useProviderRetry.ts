// baskule: review M3. OpenCode's provider snapshot is not refreshed on an interval upstream, so a
// probe that failed while the computer was down or waking would leave the composer disabled for
// good. While it is unavailable, ask the server to probe again every few seconds.
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { BASKULE_UI } from "./flags";

const RETRY_MS = 8_000;

export function useBaskuleProviderRetry(environmentId: EnvironmentId, unavailable: boolean) {
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const active = BASKULE_UI && unavailable;
  const retry = useEffectEvent(() => {
    void refreshProviders({ environmentId, input: {} });
  });
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(retry, RETRY_MS);
    return () => clearInterval(timer);
  }, [active]);
}
