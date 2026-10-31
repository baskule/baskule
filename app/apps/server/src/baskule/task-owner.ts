import type { OrchestrationV2Author, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

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
    readonly startedAt: DateTime.Utc | null;
  }>;
}
const active = (status: string) => ["pending", "starting", "running", "waiting"].includes(status);

/** A task created by an agent belongs to its human input, including inherited delegated inputs. */
export const resolveTaskOwner = Effect.fn("Baskule.resolveTaskOwner")(function* <E, R>(
  projection: OwnerProjection | undefined,
  load: (id: ThreadId) => Effect.Effect<OwnerProjection, E, R>,
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
    if (run !== undefined && run.delegatedTaskId === undefined) return;
    const parentId = current.thread.lineage.parentThreadId;
    if (!parentId) return;
    const childId = current.thread.id;
    const parent = yield* load(parentId);
    const delegatedTaskId = run?.delegatedTaskId;
    const task =
      run === undefined
        ? parent.subagents
            .filter((task) => task.childThreadId === childId && active(task.status))
            .toSorted(
              (a, b) =>
                (a.startedAt === null ? -Infinity : DateTime.toEpochMillis(a.startedAt)) -
                  (b.startedAt === null ? -Infinity : DateTime.toEpochMillis(b.startedAt)) ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            )[0]
        : parent.subagents.find(
            (task) => task.childThreadId === childId && task.id === delegatedTaskId,
          );
    if (!task) return;
    current = parent;
    run = parent.runs.find((run) => run.id === task.runId);
  }
});
