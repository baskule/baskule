import type { OrchestrationV2ThreadProjection, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";

/** Background work belongs to the author who started the caller's active run. */
export function usageAuthor(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages"> | undefined,
) {
  if (!projection) return undefined;
  const run =
    projection.runs.find((r) => ["starting", "running", "waiting"].includes(r.status)) ??
    projection.runs.at(-1);
  return projection.messages.find((m) => m.id === run?.userMessageId)?.author;
}

type ReadRunInputs<E, R> = <K extends "runs" | "messages">(
  threadId: ThreadId,
  fields: ReadonlyArray<K>,
  filter?: ProjectionRecordFilter,
) => Effect.Effect<Pick<OrchestrationV2ThreadProjection, K>, E, R>;

/** Synthetic inputs inherit the exact originating run, never later queued work. */
export const runInputAuthor = Effect.fn("Baskule.runInputAuthor")(function* <E, R>(
  threadId: ThreadId,
  runId: RunId | null | undefined,
  read: ReadRunInputs<E, R>,
) {
  if (runId == null) return;
  const origin = yield* read(threadId, ["runs"], { runIds: [runId] });
  const run = origin.runs.find((run) => run.id === runId);
  if (!run) return;
  const source = yield* read(threadId, ["messages"], { messageIds: [run.userMessageId] });
  return source.messages.find((message) => message.id === run.userMessageId)?.author;
});
