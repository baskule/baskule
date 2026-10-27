import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
export const providerClients = makeProviderClientRegistry([openCodeClient]);
