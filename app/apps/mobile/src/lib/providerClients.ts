import { isProviderDriverKind } from "@t3tools/contracts";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
const providerClients = makeProviderClientRegistry([openCodeClient]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
