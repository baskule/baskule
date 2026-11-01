import { isProviderDriverKind, type ProviderDriverKind } from "@t3tools/contracts";
import { modelShortName } from "@t3tools/provider-core/modelShortName";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";

export const providerClients = makeProviderClientRegistry([openCodeClient]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}

export function resolveModelShortName(
  model: { readonly name: string; readonly shortName?: string | undefined },
  driverKind: ProviderDriverKind | null | undefined,
): string | undefined {
  if (model.shortName) return model.shortName;
  const families = driverKind ? providerClients.get(driverKind)?.modelFamilies : undefined;
  return modelShortName(model.name, families ?? []);
}
