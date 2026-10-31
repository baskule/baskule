import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { resolveTaskOwner } from "./task-owner.ts";

type Projection = NonNullable<Parameters<typeof resolveTaskOwner>[0]>;
const alice = { id: "alice", name: "Alice" };
const bob = { id: "bob", name: "Bob" };
const projection = (id: string, parent: string | null = null): Projection => ({
  thread: { id: ThreadId.make(id), lineage: { parentThreadId: parent ? ThreadId.make(parent) : null } },
  runs: [], messages: [], subagents: [],
});
const run = (id: string, delegatedTaskId?: string) => ({
  id, userMessageId: id, ordinal: 1, status: "running", delegatedTaskId,
});

describe("agent-created task owner", () => {
  it.effect("uses the active input and inherits the spawning run instead of a newer parent turn", () =>
    Effect.gen(function* () {
      const root = {
        ...projection("root"),
        runs: [run("alice"), { ...run("bob"), ordinal: 2 }],
        messages: [{ id: "alice", author: alice }, { id: "bob", author: bob }],
        subagents: [{ id: "task", childThreadId: ThreadId.make("child"), runId: "alice", startedAt: null, status: "completed" }],
      };
      const child = { ...projection("child", "root"), runs: [run("child", "task")], messages: [{ id: "child" }] };
      const load = () => Effect.succeed(root);
      expect(yield* resolveTaskOwner(root, load)).toEqual(bob);
      expect(yield* resolveTaskOwner(child, load)).toEqual(alice);
    }),
  );
  it.effect("inherits nested runless children and fails closed for missing ancestry", () =>
    Effect.gen(function* () {
      const root = {
        ...projection("root"), runs: [run("alice")], messages: [{ id: "alice", author: alice }],
        subagents: [{ id: "native", childThreadId: ThreadId.make("child"), runId: "alice", startedAt: null, status: "running" }],
      };
      const child = {
        ...projection("child", "root"),
        subagents: [{ id: "nested", childThreadId: ThreadId.make("nested"), runId: null, startedAt: null, status: "running" }],
      };
      const load = (id: ThreadId) => Effect.succeed(id === "root" ? root : child);
      expect(yield* resolveTaskOwner(projection("nested", "child"), load)).toEqual(alice);
      expect(yield* resolveTaskOwner(projection("orphan"), load)).toBeUndefined();
    }),
  );
  it.effect("does not borrow a delegated child's author for an unrelated or mismatched run", () =>
    Effect.gen(function* () {
      const root = {
        ...projection("root"), runs: [run("bob")], messages: [{ id: "bob", author: bob }],
        subagents: [{ id: "spawn", childThreadId: ThreadId.make("child"), runId: "bob", startedAt: null, status: "running" }],
      };
      for (const activeRun of [run("unattributed"), run("unattributed", "wrong-spawn")]) {
        const child = { ...projection("child", "root"), runs: [activeRun], messages: [{ id: "unattributed" }] };
        expect(yield* resolveTaskOwner(child, () => Effect.succeed(root))).toBeUndefined();
      }
    }),
  );

  it.effect("keeps a native child's first active caller when another author joins", () =>
    Effect.gen(function* () {
      const root = {
        ...projection("root"), runs: [run("alice"), run("bob")], messages: [{ id: "alice", author: alice }, { id: "bob", author: bob }],
        subagents: [
          { id: "joined", childThreadId: ThreadId.make("child"), runId: "alice", status: "running", startedAt: DateTime.makeUnsafe("2026-10-30T12:01:00Z") },
          { id: "first", childThreadId: ThreadId.make("child"), runId: "bob", status: "running", startedAt: DateTime.makeUnsafe("2026-10-30T12:00:00Z") },
        ],
      };
      expect(yield* resolveTaskOwner(projection("child", "root"), () => Effect.succeed(root))).toEqual(bob);
    }),
  );

});
