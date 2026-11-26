import { CheckpointRef } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { CheckpointScopeId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

const finalizationLayer = (
  scopeId: CheckpointScopeId,
  runId: RunId,
  steps: string[],
  refresh: (typeof RunFinalization.RunFinalizationObserver)["Service"]["refresh"],
) => {
  const usedRepositoryScopeId = CheckpointScopeId.make(`${scopeId}_api`);
  const idleRepositoryScopeId = CheckpointScopeId.make(`${scopeId}_docs`);
  const repositoryCheckpoint = (repositoryScopeId: CheckpointScopeId, checkpointRunId: RunId) => ({
    scopeId: repositoryScopeId,
    runId: checkpointRunId,
    ordinalWithinScope: 1,
    appRunOrdinal: null,
    status: "ready" as const,
    ref: CheckpointRef.make(`refs/t3/test/${repositoryScopeId}`),
  });
  return RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () =>
            Effect.sync(() => {
              steps.push("checkpoint");
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [],
              checkpointScopes: [
                { id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" },
                {
                  id: usedRepositoryScopeId,
                  runId,
                  kind: "manual" as const,
                  cwd: "/api",
                  repositoryPath: "/api",
                },
                {
                  id: idleRepositoryScopeId,
                  runId,
                  kind: "manual" as const,
                  cwd: "/docs",
                  repositoryPath: "/docs",
                },
              ],
              checkpoints: [
                repositoryCheckpoint(usedRepositoryScopeId, runId),
                repositoryCheckpoint(idleRepositoryScopeId, RunId.make("run_before")),
              ],
            }),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh,
          refreshRepositories: () => Effect.void,
        }),
      ),
    ),
  );
};

it.effect("completes finalization when the post-checkpoint workspace refresh fails", () => {
  const threadId = ThreadId.make("thread_refresh_failure");
  const runId = RunId.make("run_refresh_failure");
  const scopeId = CheckpointScopeId.make("scope_refresh_failure");
  const captured: string[] = [];
  const layer = finalizationLayer(scopeId, runId, captured, () =>
    Effect.gen(function* () {
      captured.push("refresh");
      return yield* new RunFinalization.RunFinalizationRefreshError({
        cwd: "/repo",
        cause: new Error("Git command timed out"),
      });
    }),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    // Only the tracked repository this run checkpointed is refreshed.
    assert.deepEqual(captured, ["checkpoint", "refresh", "repositories:/api"]);
  }).pipe(Effect.provide(layer));
});
