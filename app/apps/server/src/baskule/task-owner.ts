import type { OrchestrationV2Author, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

interface OwnerProjection {
  readonly thread: {
    readonly id: ThreadId;
    readonly lineage: { readonly parentThreadId: ThreadId | null };
  };
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly status: string;
    readonly userMessageId: string;
    readonly delegatedTaskId?: string | undefined;
  }>;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly author?: OrchestrationV2Author | undefined;
  }>;
  readonly subagents: ReadonlyArray<{
    readonly id: string;
    readonly childThreadId: ThreadId | null;
    readonly runId: string | null;
    readonly status: string;
  }>;
}
const active = (status: string) => ["pending", "starting", "running", "waiting"].includes(status);

/** A task created by an agent belongs to its human input, including inherited delegated inputs. */
export const resolveTaskOwner = Effect.fn("Baskule.resolveTaskOwner")(function* (
  projection: OwnerProjection | undefined,
  load: (id: ThreadId) => Effect.Effect<OwnerProjection, OrchestratorMcpFailure>,
) {
  let current = projection;
  let run = current?.runs
    .filter((r) => active(r.status))
    .toSorted((a, b) => b.ordinal - a.ordinal)[0];
  const seen = new Set<ThreadId>();
  while (current && !seen.has(current.thread.id) && seen.size < 32) {
    seen.add(current.thread.id);
    const owner = current.messages.find((message) => message.id === run?.userMessageId)?.author;
    if (owner) return owner;
    const parentId = current.thread.lineage.parentThreadId;
    if (!parentId) return;
    const childId = current.thread.id;
    const parent = yield* load(parentId);
    const task =
      parent.subagents.find(
        (task) => task.childThreadId === childId && task.id === run?.delegatedTaskId,
      ) ?? parent.subagents.find((task) => task.childThreadId === childId && active(task.status));
    if (!task) return;
    current = parent;
    run = parent.runs.find((run) => run.id === task.runId);
  }
});
