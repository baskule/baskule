import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as SqlClient from "effect/sql/SqlClient";
import { ScheduledTaskUpsertInput, ThreadId, type ScheduledTaskError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const taskActor = { id: "alice", name: "Alice" };

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input, { id: "alice", name: "Alice" });
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      const before = (yield* service.list(taskActor)).tasks;
      const refused = yield* service.upsert(edit, { id: "bob", name: "Bob" }).pipe(Effect.flip);
      expect(refused.message).toBe("Only the task's author can change or run it.");
      expect((yield* service.list(taskActor)).tasks).toEqual(before);
      const edited = (yield* service.upsert(edit, { id: "alice", name: "Alice" })).task;
      expect(edited.title).toBe("Edited");
      expect(edited.author).toEqual({ id: "alice", name: "Alice" });
      expect((yield* service.list(taskActor)).tasks[0]?.author).toEqual(edited.author);
      yield* service.delete({ id: created.task.id }, taskActor);

      const failure = yield* service.upsert(edit, taskActor).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list(taskActor)).tasks).toEqual([]);

      expect((yield* service.upsert(input, taskActor)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input, taskActor);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update, taskActor);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list(taskActor)).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert(
        {
          ...update,
          schedule: { type: "fixed_time", timeOfDay: "09:30" },
        },
        taskActor,
      );
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the task list order when a toggle or edit rewrites updated_at", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = (id: string) => ({
        id,
        title: id,
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stable-order",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const listedIds = service
        .list(taskActor)
        .pipe(Effect.map(({ tasks }) => tasks.map((task) => String(task.id))));

      const older = yield* service.upsert(
        yield* decodeUpsertInput(input("scheduled-task:older")),
        taskActor,
      );
      yield* TestClock.adjust("1 second");
      yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:newer")), taskActor);
      const order = ["scheduled-task:newer", "scheduled-task:older"];
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const toggled = yield* service.setEnabled({ id: older.task.id, enabled: false }, taskActor);
      expect(toggled.task.updatedAt > older.task.updatedAt).toBe(true);
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const edit = { ...input(older.task.id), requireExisting: true, title: "Edited" };
      yield* service.upsert(yield* decodeUpsertInput({ ...edit, enabled: false }), taskActor);
      expect(yield* listedIds).toEqual(order);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("refuses every cross-author control without changing the persisted task or secret", () =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const bob = { id: "bob", name: "Bob" };
      const owner = { ...taskActor, canStopOthers: true };
      const input = yield* decodeUpsertInput({
        commandId: "authority",
        title: "Bob's task",
        prompt: "Use Bob's accounts {{body.message}}",
        enabled: false,
        schedule: {
          type: "webhook",
          signature: { header: "x-signature", encoding: "hex", prefix: "", secret: "bob-secret" },
        },
        projectId: "project-authority",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const { task } = yield* service.upsert(input, bob);
      const persisted = sql`SELECT * FROM scheduled_tasks WHERE task_id = ${task.id}`;
      const before = yield* persisted;
      for (const actor of [taskActor, owner, undefined, { id: "", name: "Unknown" }]) {
        const operations: Array<Effect.Effect<unknown, ScheduledTaskError>> = [
          service.upsert({ ...input, id: task.id, prompt: "Attacker prompt" }, actor),
          service.upsert(input, actor),
          service.upsert(
            { ...input, id: task.id, threadId: ThreadId.make("thread:attacker") },
            actor,
          ),
          service.setEnabled({ id: task.id, enabled: true }, actor),
          service.runNow({ id: task.id }, actor),
          service.rotateWebhookToken({ id: task.id }, actor),
          service.listWebhookDeliveries({ id: task.id }, actor),
        ];
        for (const operation of operations) {
          const error = yield* operation.pipe(Effect.asVoid, Effect.flip);
          expect(error.message).toMatch(/author|Sign in/);
          expect(yield* persisted).toEqual(before);
        }
        expect((yield* service.list(actor)).tasks[0]?.webhook).toBeUndefined();
      }
      const stopOperations: Array<Effect.Effect<unknown, ScheduledTaskError>> = [
        service.setEnabled({ id: task.id, enabled: false }, taskActor),
        service.delete({ id: task.id }, taskActor),
      ];
      for (const operation of stopOperations) {
        expect((yield* operation.pipe(Effect.asVoid, Effect.flip)).message).toContain("author");
        expect(yield* persisted).toEqual(before);
      }
      const edited = (yield* service.upsert(
        {
          ...input,
          id: task.id,
          prompt: "Bob's updated prompt",
          threadId: ThreadId.make("thread:bob"),
        },
        bob,
      )).task;
      expect(edited.author).toEqual(bob);
      const rotated = (yield* service.rotateWebhookToken({ id: task.id }, bob)).task;
      expect(rotated.webhook?.path).not.toBe(task.webhook?.path);
      yield* service.setEnabled({ id: task.id, enabled: true }, bob);
      const stopped = (yield* service.setEnabled({ id: task.id, enabled: false }, owner)).task;
      expect(stopped.author).toEqual(bob);
      expect(stopped.enabled).toBe(false);
      expect(stopped.webhook).toBeUndefined();
      expect(
        (yield* service.setEnabled({ id: task.id, enabled: true }, owner).pipe(Effect.flip))
          .message,
      ).toContain("author");
      yield* sql`UPDATE scheduled_tasks SET author_json = NULL WHERE task_id = ${task.id}`;
      expect((yield* service.upsert(input, bob).pipe(Effect.flip)).message).toContain("author");
      expect((yield* service.runNow({ id: task.id }, bob).pipe(Effect.flip)).message).toContain(
        "author",
      );
      yield* sql`UPDATE scheduled_tasks SET author_json = ${JSON.stringify(bob)} WHERE task_id = ${task.id}`;
      yield* service.delete({ id: task.id }, owner);
      expect(yield* persisted).toEqual([]);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
