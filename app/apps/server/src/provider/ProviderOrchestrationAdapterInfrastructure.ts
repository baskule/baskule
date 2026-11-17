import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

export type ProviderOrchestrationAdapterInfrastructure = IdAllocator.IdAllocatorV2;

// Subagent threads created before short ids keep their stored id when an adapter resumes them.
export const layerIdAllocator = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
      WHERE thread_id LIKE 'thread:provider:%'
    `.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("orchestration-v2.legacy-subagent-thread-ids-unavailable", {
          cause,
        }).pipe(Effect.as([])),
      ),
    );
    return IdAllocator.layerWithLegacySubagentThreads(new Set(rows.map((row) => row.threadId)));
  }),
);

/** Reuse the continuation worker's exact layer reference so memoization shares one queue. */
export const layer = Layer.mergeAll(layerIdAllocator, ProviderContinuationRequests.layer);
