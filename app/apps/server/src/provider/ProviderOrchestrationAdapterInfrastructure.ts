import * as Layer from "effect/Layer";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

export type ProviderOrchestrationAdapterInfrastructure = IdAllocator.IdAllocatorV2;

/**
 * `providerContinuationRequestsLayer` must be the same layer reference the
 * orchestration runtime provides to its continuation worker so Effect layer
 * memoization yields one shared queue.
 */
export const layer = Layer.mergeAll(IdAllocator.layer, ProviderContinuationRequests.layer);
