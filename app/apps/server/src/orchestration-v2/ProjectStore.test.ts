import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );

    it.effect("keeps pin and archive times across later updates", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-organized");
        const at = "2026-03-24T00:00:00.000Z";
        const event = { aggregateKind: "project", aggregateId: projectId, occurredAt: at } as const;
        const meta = { commandId: null, causationEventId: null, correlationId: null, metadata: {} };
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 1,
          eventId: EventId.make("event-organized-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "Organized",
            workspaceRoot: "/tmp/project-organized",
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
          },
        });
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 2,
          eventId: EventId.make("event-organized-pinned"),
          type: "project.meta-updated",
          payload: { projectId, pinnedAt: at, archivedAt: at, updatedAt: at },
        });
        yield* projects.apply({
          ...event,
          ...meta,
          sequence: 3,
          eventId: EventId.make("event-organized-renamed"),
          type: "project.meta-updated",
          payload: { projectId, title: "Renamed", updatedAt: at },
        });
        const project = Option.getOrNull(yield* projects.get(projectId));
        assert.strictEqual(project?.pinnedAt, at);
        assert.strictEqual(project?.archivedAt, at);
      }),
    );

    it.effect(
      "reads historical string-array project defaults and retains their options during replay",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectStore.ProjectStoreV2;
          const events = yield* OrchestrationEventStore.OrchestrationEventStore;
          const sql = yield* SqlClient.SqlClient;
          const projectId = ProjectId.make("project-historical-options");
          const eventId = EventId.make("event-historical-options");
          const modelSelection = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
            options: [
              { id: "variant", value: "high" },
              { id: "thinking", value: true },
              { id: "fast", value: false },
            ],
          };
          const legacyJson = JSON.stringify({
            ...modelSelection,
            options: JSON.stringify(modelSelection.options),
          });
          const created = yield* events.appendProjectEvent({
            eventId,
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: "2026-03-24T00:00:00.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: "Historical options",
              workspaceRoot: "/tmp/project-historical-options",
              defaultModelSelection: modelSelection,
              scripts: [],
              createdAt: "2026-03-24T00:00:00.000Z",
              updatedAt: "2026-03-24T00:00:00.000Z",
            },
          });
          yield* projects.apply(created);
          yield* sql`
          UPDATE projection_projects SET default_model_selection_json = ${legacyJson}
          WHERE project_id = ${projectId}
        `;
          yield* sql`
          UPDATE orchestration_events
          SET payload_json = json_set(payload_json, '$.defaultModelSelection', json(${legacyJson}))
          WHERE event_id = ${eventId}
        `;
          const historicalEvent = yield* sql`
          SELECT payload_json FROM orchestration_events WHERE event_id = ${eventId}
        `;
          assert.deepStrictEqual(
            (yield* projects.listShells({ projectIds: [projectId] })).map(
              (shell) => shell.defaultModelSelection,
            ),
            [modelSelection],
          );
          assert.deepStrictEqual(
            yield* sql`
            SELECT default_model_selection_json FROM projection_projects WHERE project_id = ${projectId}
          `,
            [{ default_model_selection_json: legacyJson }],
          );
          const replayed = yield* events
            .readApplicationEvents({
              afterSequence: created.sequence - 1,
              throughSequence: created.sequence,
            })
            .pipe(Stream.runCollect);
          assert.lengthOf(replayed, 1);
          for (const event of replayed) {
            assert.equal(event.aggregateKind, "project");
            if (event.aggregateKind !== "project") return;
            yield* projects.apply(event);
          }
          assert.deepStrictEqual(
            Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
            modelSelection,
          );
          assert.deepStrictEqual(
            yield* sql`
            SELECT default_model_selection_json FROM projection_projects WHERE project_id = ${projectId}
          `,
            [{ default_model_selection_json: JSON.stringify(modelSelection) }],
          );
          assert.deepStrictEqual(
            yield* sql`SELECT payload_json FROM orchestration_events WHERE event_id = ${eventId}`,
            historicalEvent,
          );
        }).pipe(Effect.provide(OrchestrationEventStore.layer)),
    );

    it.effect("marks a project's title as custom only once it is renamed", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const projectId = ProjectId.make("project-renamed");
        const event = {
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        } as const;
        const hasCustomTitle = () =>
          projects
            .getShell(projectId)
            .pipe(Effect.map((shell) => Option.getOrNull(shell)?.hasCustomTitle));
        yield* projects.apply({
          ...event,
          sequence: 1,
          eventId: EventId.make("event-renamed-created"),
          type: "project.created",
          payload: {
            projectId,
            title: "repo",
            workspaceRoot: "/tmp/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });
        assert.strictEqual(yield* hasCustomTitle(), false);
        yield* projects.apply({
          ...event,
          sequence: 2,
          eventId: EventId.make("event-renamed-title"),
          type: "project.meta-updated",
          payload: { projectId, title: "custom repo", updatedAt: "2026-03-24T00:00:02.000Z" },
        });
        assert.strictEqual(yield* hasCustomTitle(), true);
        yield* projects.apply({
          ...event,
          sequence: 3,
          eventId: EventId.make("migration:39:project:project-renamed:baseline"),
          type: "project.created",
          payload: {
            projectId,
            title: "repo",
            workspaceRoot: "/tmp/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:03.000Z",
          },
        });
        assert.strictEqual(yield* hasCustomTitle(), true);
        assert.strictEqual(
          Option.getOrNull(yield* projects.getShell(projectId))?.title,
          "custom repo",
        );
      }),
    );
  },
);
