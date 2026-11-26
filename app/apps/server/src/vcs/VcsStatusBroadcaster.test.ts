import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import type {
  BackgroundScope,
  VcsBranchStatus,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { GitCommandError, GitManagerError } from "@t3tools/contracts";

import * as VcsAutomaticFetchInterval from "./VcsAutomaticFetchInterval.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const remoteStatusWithPr: VcsStatusRemoteResult = {
  ...baseRemoteStatus,
  pr: {
    number: 2978,
    title: "[codex] Rewrite client connection architecture",
    url: "https://github.com/pingdotgg/t3code/pull/2978",
    baseRef: "main",
    headRef: "upstream-topic",
    state: "open",
  },
};

function layerTestFor(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  currentDivergence?: Pick<VcsStatusRemoteResult, "aheadCount" | "behindCount">;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  remoteStatusReusedDetails?: Array<boolean>;
  localStatusBranchChanges?: Array<boolean>;
  refSnapshot?: string | null;
  worktreeStamp?: string | null;
  remoteStatusError?: GitManagerError;
  backgroundWorkEnabled?: boolean;
  automaticFetchInterval?: Effect.Effect<Duration.Duration>;
  beforeRemoteStatus?: Effect.Effect<void, GitManagerError>;
  beforeLocalStatus?: Effect.Effect<void>;
  beforeCurrentBranch?: Effect.Effect<void>;
  beforeInvalidate?: Effect.Effect<void>;
  branchRead?: () => Effect.Effect<string | null, GitCommandError>;
  fileSystem?: FileSystem.FileSystem;
  pullCurrentBranch?: GitWorkflowService.GitWorkflowService["Service"]["pullCurrentBranch"];
  headPath?: string;
  headPathCalls?: number;
  failLocalStatus?: boolean;
  onLocalStatusFailure?: Effect.Effect<void>;
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(
      state.fileSystem
        ? Layer.merge(Layer.succeed(FileSystem.FileSystem, state.fileSystem), Path.layer)
        : NodeServices.layer,
    ),
    Layer.provide(layerBackgroundPolicy(() => state.backgroundWorkEnabled !== false)),
    Layer.provide(
      Layer.succeed(
        VcsAutomaticFetchInterval.VcsAutomaticFetchInterval,
        state.automaticFetchInterval ?? Effect.succeed(Duration.seconds(30)),
      ),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: (_input, options) =>
          Effect.suspend(() => {
            state.localStatusCalls += 1;
            const includeBranchChanges = options?.includeBranchChanges !== false;
            state.localStatusBranchChanges?.push(includeBranchChanges);
            const { branchChanges: _branchChanges, ...withoutBranchChanges } =
              state.currentLocalStatus;
            if (state.failLocalStatus) {
              return (state.onLocalStatusFailure ?? Effect.void).pipe(
                Effect.andThen(
                  Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "index.lock is held",
                    }),
                  ),
                ),
              );
            }
            return (state.beforeLocalStatus ?? Effect.void).pipe(
              Effect.as(includeBranchChanges ? state.currentLocalStatus : withoutBranchChanges),
            );
          }),
        repositoryRoot: () => Effect.sync(() => (state.currentLocalStatus.isRepo ? "/repo" : null)),
        currentBranch: () =>
          state.branchRead
            ? state.branchRead()
            : (state.beforeCurrentBranch ?? Effect.void).pipe(
                Effect.andThen(Effect.sync(() => state.currentLocalStatus.refName)),
              ),
        readLocalStatusRefSnapshot: () =>
          Effect.sync(() => (state.refSnapshot === undefined ? "refs" : state.refSnapshot)),
        readRefSnapshot: (_cwd, refs) =>
          Effect.sync(() => {
            const localRefs =
              refs ?? (state.refSnapshot === undefined ? "refs" : state.refSnapshot);
            return localRefs === null || state.worktreeStamp === null
              ? null
              : `${localRefs}\0${state.worktreeStamp ?? ""}`;
          }),
        upstreamDivergence: () =>
          Effect.sync(() => {
            const refName = state.currentLocalStatus.refName;
            if (!state.currentRemoteStatus?.hasUpstream || refName === null) return null;
            const { aheadCount, behindCount } =
              state.currentDivergence ?? state.currentRemoteStatus;
            return {
              refName,
              aheadCount,
              behindCount,
              details: {
                isRepo: true,
                hasPrimaryRemote: true,
                defaultBranch: "main",
                isDefaultBranch: false,
                branch: refName,
                upstreamRef: `origin/${refName}`,
                hasUpstream: true,
                aheadCount,
                behindCount,
                aheadOfDefaultCount: aheadCount,
              },
            };
          }),
        remoteStatus: (_input, options) =>
          Effect.suspend(() => {
            return (state.beforeRemoteStatus ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  state.remoteStatusCalls += 1;
                  state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
                  state.remoteStatusReusedDetails?.push(options?.statusDetails !== undefined);
                  return state.currentRemoteStatus;
                }),
              ),
              Effect.tap(() =>
                state.remoteStatusError ? Effect.fail(state.remoteStatusError) : Effect.void,
              ),
            );
          }),
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
          }).pipe(Effect.andThen(state.beforeInvalidate ?? Effect.void)),
        invalidateRemoteStatus: () =>
          Effect.sync(() => {
            state.remoteInvalidationCalls += 1;
          }),
        invalidateStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
            state.remoteInvalidationCalls += 1;
          }),
        ...(state.pullCurrentBranch ? { pullCurrentBranch: state.pullCurrentBranch } : {}),
        headPath: () =>
          Effect.sync(() => {
            state.headPathCalls = (state.headPathCalls ?? 0) + 1;
            return state.headPath ?? null;
          }),
      }),
    ),
  );
}

function layerBackgroundPolicy(shouldRunScopeWork: (scope: BackgroundScope) => boolean) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    snapshot: Effect.succeed({
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: TEST_EPOCH,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: false,
      updatedAt: TEST_EPOCH,
    }),
    shouldRunScopeWork: (scope) => Effect.sync(() => shouldRunScopeWork(scope)),
    shouldRunOpportunisticWork: Effect.succeed(true),
  });
}

describe("VcsStatusBroadcaster", () => {
  it.effect.each(["passive subscriptions", "status reads", "local refreshes", "full refreshes"])(
    "bounds historical snapshots from %s while retaining recently read entries",
    (source) => {
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/hot-repo" });
        for (let index = 0; index < 1_000; index += 1) {
          const cwd = `/visited-repo-${index}`;
          if (source === "passive subscriptions") {
            yield* Stream.runHead(broadcaster.streamStatus({ cwd, includeRemote: false }));
          } else if (source === "status reads") {
            yield* broadcaster.getStatus({ cwd });
          } else if (source === "local refreshes") {
            yield* broadcaster.refreshLocalStatus(cwd);
          } else {
            yield* broadcaster.refreshStatus(cwd);
          }
          const localCalls = state.localStatusCalls;
          const remoteCalls = state.remoteStatusCalls;
          yield* broadcaster.getStatus({ cwd: "/hot-repo" });
          assert.equal(state.localStatusCalls, localCalls);
          assert.equal(state.remoteStatusCalls, remoteCalls);
        }

        const localCalls = state.localStatusCalls;
        yield* Stream.runHead(
          broadcaster.streamStatus({ cwd: "/visited-repo-999", includeRemote: false }),
        );
        assert.equal(state.localStatusCalls, localCalls);
        yield* Stream.runHead(
          broadcaster.streamStatus({ cwd: "/visited-repo-0", includeRemote: false }),
        );
        assert.equal(state.localStatusCalls, localCalls + 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("keeps a watched cwd's snapshot until its last subscriber leaves", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      backgroundWorkEnabled: false,
      automaticFetchInterval: Effect.succeed(Duration.zero),
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const subscription = yield* Scope.make();
      const remoteLoaded = yield* Deferred.make<void>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/active-repo" }), (event) =>
        event._tag === "remoteUpdated" ? Deferred.succeed(remoteLoaded, undefined) : Effect.void,
      ).pipe(Effect.forkIn(subscription));
      yield* Deferred.await(remoteLoaded);
      for (let index = 0; index < 1_000; index += 1) {
        yield* broadcaster.getStatus({ cwd: `/visited-repo-${index}` });
      }

      // With fetching disabled, nothing would reload a remote dropped from the cache.
      const localCalls = state.localStatusCalls;
      const remoteCalls = state.remoteStatusCalls;
      const snapshot = yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/active-repo" }));
      assert.deepStrictEqual(Option.getOrThrow(snapshot), {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: remoteStatusWithPr,
      });
      assert.equal(state.localStatusCalls, localCalls);
      assert.equal(state.remoteStatusCalls, remoteCalls);
      yield* Scope.close(subscription, Exit.void);
      for (let index = 1_000; index < 2_000; index += 1) {
        yield* broadcaster.getStatus({ cwd: `/visited-repo-${index}` });
      }
      const releasedCalls = state.localStatusCalls;
      yield* broadcaster.getStatus({ cwd: "/active-repo" });
      assert.equal(state.localStatusCalls, releasedCalls + 1);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("keeps an unwatched refresh coherent while other directories fill the cache", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 2 },
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const policyStarted = Deferred.makeUnsafe<void>();
    const releasePolicy = Deferred.makeUnsafe<void>();
    const layer = layerTestFor(state).pipe(
      Layer.provide(
        Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
          isEnabled: () =>
            Deferred.succeed(policyStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePolicy)),
              Effect.as(false),
            ),
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const refresh = yield* broadcaster.refreshStatus("/refreshing-repo").pipe(Effect.forkScoped);
      yield* Deferred.await(policyStarted);
      for (let index = 0; index < 256; index += 1) {
        yield* broadcaster.refreshLocalStatus(`/other-repo-${index}`);
      }
      yield* Deferred.succeed(releasePolicy, undefined);
      const { refsDigest: _refsDigest, ...result } = yield* Fiber.join(refresh);
      assert.deepStrictEqual(result, { ...baseLocalStatus, ...state.currentRemoteStatus });
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("trims excess snapshots when the last watched directories are released", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      backgroundWorkEnabled: false,
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scopes = [];
      for (let index = 0; index < 257; index += 1) {
        const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        scopes.push(scope);
        const ready = yield* Deferred.make<void>();
        yield* Stream.runForEach(
          broadcaster.streamStatus({ cwd: `/watched-repo-${index}`, includeRemote: false }),
          () => Deferred.succeed(ready, undefined),
        ).pipe(Effect.forkIn(scope));
        yield* Deferred.await(ready);
      }
      for (const scope of scopes) yield* Scope.close(scope, Exit.void);
      const reads = state.localStatusCalls;
      // A cache read protects its own cwd before trimming; only teardown can evict this oldest cwd.
      yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/watched-repo-0", includeRemote: false }),
      );
      assert.equal(state.localStatusCalls, reads + 1);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("refreshes queued behind a running one share the next git status read", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeLocalStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const running = yield* broadcaster
        .refreshLocalStatus("/repo")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(started);
      // Requested while the first read runs, so that read may predate their change.
      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      const queued = yield* Effect.all(
        [broadcaster.refreshLocalStatus("/repo"), broadcaster.refreshLocalStatus("/repo")],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);

      assert.isFalse((yield* Fiber.join(running)).hasWorkingTreeChanges);
      const [second, third] = yield* Fiber.join(queued);
      assert.isTrue(second.hasWorkingTreeChanges);
      assert.isTrue(third.hasWorkingTreeChanges);
      assert.strictEqual(state.localStatusCalls, 2);

      yield* broadcaster.refreshLocalStatus("/repo");
      assert.strictEqual(state.localStatusCalls, 3);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect(
    "streams fresh branch-only reads, detached HEAD, non-repositories, and detailed demand without mixing results",
    () => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        fileSystem: FileSystem.makeNoop({
          realPath: (cwd) => Effect.succeed(cwd === "/alias" ? "/repo" : cwd),
        }),
      };
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const branches = yield* Stream.toPull(broadcaster.streamBranchStatus({ cwd: "/repo" }));
        assert.deepEqual(yield* branches, [{ refName: baseLocalStatus.refName, isRepo: true }]);
        assert.equal(state.localStatusCalls, 0);
        state.currentLocalStatus = { ...baseLocalStatus, refName: "external" };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* branches, [{ refName: "external", isRepo: true }]);
        state.currentLocalStatus = { ...baseLocalStatus, refName: null };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* branches, [{ refName: null, isRepo: true }]);
        state.currentLocalStatus = { ...baseLocalStatus, isRepo: false, refName: null };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* branches, [{ refName: null, isRepo: false }]);
        assert.equal(state.localStatusCalls, 0);
        const detailScope = yield* Scope.make();
        const details = yield* Stream.toPull(
          broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        ).pipe(Scope.provide(detailScope));
        assert.deepEqual(yield* details, [
          { _tag: "snapshot", local: state.currentLocalStatus, remote: null },
        ]);
        const callsWithDetail = state.localStatusCalls;
        const extraBranches = yield* Stream.toPull(
          broadcaster.streamBranchStatus({ cwd: "/repo" }),
        );
        yield* extraBranches;
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.equal(state.localStatusCalls, callsWithDetail);
        state.currentLocalStatus = {
          ...baseLocalStatus,
          refName: "changed",
          workingTree: { files: [], insertions: 12, deletions: 3 },
        };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* details, [
          { _tag: "localUpdated", local: state.currentLocalStatus },
        ]);
        assert.deepEqual(yield* branches, [{ refName: "changed", isRepo: true }]);
        const secondScope = yield* Scope.make();
        const secondDetails = yield* Stream.toPull(
          broadcaster.streamStatus({ cwd: "/alias", includeRemote: false }),
        ).pipe(Scope.provide(secondScope));
        yield* secondDetails;
        yield* Scope.close(detailScope, Exit.void);
        state.currentLocalStatus = {
          ...state.currentLocalStatus,
          workingTree: { files: [], insertions: 20, deletions: 4 },
        };
        yield* broadcaster.refreshLocalStatus("/repo");
        assert.deepEqual(yield* secondDetails, [
          { _tag: "localUpdated", local: state.currentLocalStatus },
        ]);
        yield* Scope.close(secondScope, Exit.void);
        const callsAfterRelease = state.localStatusCalls;
        state.currentLocalStatus = {
          ...state.currentLocalStatus,
          workingTree: { files: [], insertions: 30, deletions: 5 },
        };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.equal(state.localStatusCalls, callsAfterRelease);
        const reopened = yield* Stream.toPull(
          broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        );
        assert.deepEqual(yield* reopened, [
          { _tag: "snapshot", local: state.currentLocalStatus, remote: null },
        ]);
        state.currentLocalStatus = {
          ...baseLocalStatus,
          isRepo: false,
          refName: null,
        };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* reopened, [
          { _tag: "localUpdated", local: state.currentLocalStatus },
        ]);
        assert.deepEqual(yield* branches, [{ refName: null, isRepo: false }]);
        assert.equal(state.remoteStatusCalls, 0);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("publishes the new branch before pending detailed status completes", () => {
    const state = newState();
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const branches = yield* Stream.toPull(broadcaster.streamBranchStatus({ cwd: "/repo" }));
      yield* branches;
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      state.beforeLocalStatus = Deferred.succeed(reading, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
      );
      const details = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(reading);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      const update = yield* branches.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
      assert.deepEqual(
        update.pollUnsafe(),
        Exit.succeed([{ refName: "feature/next", isRepo: true }]),
      );
      state.beforeLocalStatus = Effect.void;
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(details);
      yield* broadcaster.getStatus({ cwd: "/repo" });
      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/latest" };
      yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
      assert.deepEqual(yield* branches, [{ refName: "feature/latest", isRepo: true }]);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("invalidates totals for a refresh arriving after detailed demand closes", () => {
    const state = newState();
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const detailScope = yield* Scope.make();
      const details = yield* Stream.toPull(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      ).pipe(Scope.provide(detailScope));
      yield* details;
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/next",
        workingTree: { files: [], insertions: 1, deletions: 0 },
      };
      state.beforeLocalStatus = Deferred.succeed(reading, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
      );
      yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
      yield* Deferred.await(reading);
      yield* Scope.close(detailScope, Exit.void);
      state.currentLocalStatus = {
        ...state.currentLocalStatus,
        workingTree: { files: [], insertions: 2, deletions: 0 },
      };
      const trailing = yield* broadcaster
        .refreshBranchStatus({ cwd: "/repo" })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      state.beforeLocalStatus = Effect.void;
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(trailing);
      const reopened = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      );
      assert.deepEqual(
        reopened,
        Option.some({ _tag: "snapshot" as const, local: state.currentLocalStatus, remote: null }),
      );
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("upgrades an in-flight branch refresh when detailed demand arrives", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: null,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      state.beforeCurrentBranch = Deferred.succeed(reading, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
      );
      const refresh = yield* broadcaster
        .refreshBranchStatus({ cwd: "/repo" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(reading);
      const detailsFiber = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      ).pipe(Effect.forkScoped);
      state.currentLocalStatus = {
        ...baseLocalStatus,
        workingTree: { files: [], insertions: 8, deletions: 2 },
      };
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(refresh);
      assert.deepEqual(
        yield* Fiber.join(detailsFiber),
        Option.some({ _tag: "snapshot" as const, local: state.currentLocalStatus, remote: null }),
      );
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("publishes terminal branch switches and validates cached status reads", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const branchEvents = yield* broadcaster.streamBranchChanges.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const subscribed = yield* Deferred.make<void>();
      const events = yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.tap((event) =>
          event._tag === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      state.currentRemoteStatus = baseRemoteStatus;
      const refreshed = yield* broadcaster.refreshStatus("/repo", { localOnly: true });
      assert.equal(refreshed.refName, "main");
      assert.isNull(refreshed.pr);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 1);
      assert.deepStrictEqual((yield* Fiber.join(events)).slice(1), [
        { _tag: "remoteUpdated", remote: null },
        { _tag: "localUpdated", local: state.currentLocalStatus },
      ]);
      assert.isNull((yield* broadcaster.getStatus({ cwd: "/repo" })).pr);
      assert.equal(state.remoteStatusCalls, 2);
      state.currentLocalStatus = { ...state.currentLocalStatus, hasWorkingTreeChanges: true };
      yield* broadcaster.refreshLocalStatus("/repo");
      state.currentLocalStatus = { ...baseLocalStatus, refName: "union" };
      state.currentRemoteStatus = null;
      const queried = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(queried.refName, "union");
      assert.isNull(queried.pr);
      const snapshot = yield* broadcaster
        .streamStatus({ cwd: "/repo", includeRemote: false })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(snapshot[0], {
        _tag: "snapshot",
        local: state.currentLocalStatus,
        remote: null,
      });
      assert.deepStrictEqual(yield* Fiber.join(branchEvents), [
        { cwd: "/repo", refName: "main" },
        { cwd: "/repo", refName: "union" },
      ]);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect(
    "preserves cached remote status when a local-only refresh stays on the same branch",
    () => {
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 2, behindCount: 3 },
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const initial = yield* broadcaster.getStatus({ cwd: "/repo" });
        const { refsDigest, ...refreshed } = yield* broadcaster.refreshStatus("/repo", {
          localOnly: true,
        });
        assert.isString(refsDigest);
        assert.deepStrictEqual(refreshed, initial);
        assert.deepStrictEqual(yield* broadcaster.getStatus({ cwd: "/repo" }), refreshed);
        assert.equal(state.localInvalidationCalls, 1);
        assert.equal(state.remoteInvalidationCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect.skipIf(!symlinksSupported)(
    "automatically pulls an enabled clean default branch when status detects it is behind",
    () => {
      let remoteStatus: VcsStatusRemoteResult = { ...baseRemoteStatus, behindCount: 2 };
      let pullCalls = 0;
      let configuredWorkspaceRoot = "";
      const localStatus: VcsStatusLocalResult = {
        ...baseLocalStatus,
        isDefaultRef: true,
        refName: "main",
      };
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: (cwd) => Effect.succeed(cwd === configuredWorkspaceRoot),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(localStatus),
            currentBranch: () => Effect.succeed(localStatus.refName),
            readLocalStatusRefSnapshot: () => Effect.succeed("refs"),
            readRefSnapshot: () => Effect.succeed("refs"),
            remoteStatus: () => Effect.succeed(remoteStatus),
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            pullCurrentBranch: () =>
              Effect.sync(() => {
                pullCalls += 1;
                remoteStatus = { ...remoteStatus, behindCount: 0 };
                return {
                  status: "pulled" as const,
                  refName: "main",
                  upstreamRef: "origin/main",
                };
              }),
          }),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-auto-pull-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-auto-pull-link-",
        });
        configuredWorkspaceRoot = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, configuredWorkspaceRoot);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const status = yield* broadcaster.refreshStatus(configuredWorkspaceRoot);

        assert.equal(pullCalls, 1);
        assert.equal(status.behindCount, 0);
      }).pipe(Effect.provide(layerTest));
    },
  );

  it.effect("an initial status read cannot overwrite an explicit refresh", () => {
    const firstReadStarted = Deferred.makeUnsafe<void>();
    const releaseFirstRead = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provide(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          currentBranch: () => Effect.succeed(baseLocalStatus.refName),
          readLocalStatusRefSnapshot: () => Effect.succeed("refs"),
          readRefSnapshot: () => Effect.succeed("refs"),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 1) {
                yield* Deferred.succeed(firstReadStarted, undefined);
                yield* Deferred.await(releaseFirstRead);
                return baseRemoteStatus;
              }
              return remoteStatusWithPr;
            }),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstReadStarted);
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.zero);
      yield* Deferred.succeed(releaseFirstRead, undefined);
      yield* Fiber.join(initial);
      yield* Fiber.join(refresh);
      assert.deepStrictEqual(
        (yield* broadcaster.getStatus({ cwd: "/repo" })).pr,
        remoteStatusWithPr.pr,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the published local snapshot when a refresh remote read fails", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      failRemoteStatus: false,
    };
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
          readLocalStatusRefSnapshot: () => Effect.succeed("refs"),
          readRefSnapshot: () => Effect.succeed("refs"),
          remoteStatus: () =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              return state.failRemoteStatus
                ? Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "remote status failed",
                    }),
                  )
                : Effect.succeed(state.currentRemoteStatus);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          invalidateStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
              state.remoteInvalidationCalls += 1;
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/partial-refresh",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 3,
      };
      state.failRemoteStatus = true;

      const refreshExit = yield* broadcaster.refreshStatus("/repo").pipe(Effect.exit);
      const snapshot = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      );

      assert.isTrue(Exit.isFailure(refreshExit));
      assert.isTrue(Option.isSome(snapshot));
      const event = Option.getOrThrow(snapshot);
      assert.equal(event._tag, "snapshot");
      if (event._tag === "snapshot") {
        assert.equal(event.local.refName, "feature/partial-refresh");
        assert.isNull(event.remote);
      }
    }).pipe(Effect.provide(layerTest));
  });

  it.effect.skipIf(!symlinksSupported)(
    "normalizes symlinked CWDs before cache lookup and workflow calls",
    () => {
      const seenCwds: string[] = [];
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.localStatusCalls += 1;
                return state.currentLocalStatus;
              }),
            currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
            remoteStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.remoteStatusCalls += 1;
                return state.currentRemoteStatus;
              }),
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                state.localInvalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                state.remoteInvalidationCalls += 1;
              }),
          } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-status-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-status-link-",
        });
        const linkDir = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, linkDir);
        const realPath = yield* fileSystem.realPath(realDir);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: linkDir });
        yield* broadcaster.getStatus({ cwd: realDir });

        assert.deepStrictEqual(seenCwds, [realPath, realPath]);
        assert.equal(state.localStatusCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTest));
    },
  );

  it.effect("publishes a checkout's branch before returning, ahead of the remote read", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const localPublished = yield* Deferred.make<VcsStatusLocalResult>();
      const remotePublished = yield* Deferred.make<VcsStatusRemoteResult | null>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "localUpdated") return Deferred.succeed(localPublished, event.local);
          return event.remote === null
            ? Effect.void
            : Deferred.succeed(remotePublished, event.remote);
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);

      const releaseRemote = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.await(releaseRemote);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      state.currentRemoteStatus = remoteStatusWithPr;
      yield* broadcaster.refreshAfterCheckout("/repo");

      assert.equal((yield* Deferred.await(localPublished)).refName, "main");
      assert.isFalse(yield* Deferred.isDone(remotePublished));

      yield* Deferred.succeed(releaseRemote, undefined);
      assert.deepStrictEqual(yield* Deferred.await(remotePublished), remoteStatusWithPr);
      assert.equal((yield* broadcaster.getStatus({ cwd: "/repo" })).pr?.number, 2978);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("a remote poll refreshes Changes totals when divergence counts stay the same", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 745, deletions: 24 },
      },
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const polled = yield* Deferred.make<void>();
      yield* broadcaster.streamStatus({ cwd: "/repo" }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "remoteUpdated") return Deferred.succeed(polled, undefined);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      state.currentLocalStatus = {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 107, deletions: 4 },
      };
      state.currentRemoteStatus = remoteStatusWithPr;
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(polled);
      const status = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(status.branchChanges, state.currentLocalStatus.branchChanges);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("a remote poll that moves no ref does not re-read local status", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const remoteUpdates = yield* Queue.unbounded<void>();
      yield* broadcaster.streamStatus({ cwd: "/repo" }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "remoteUpdated") return Queue.offer(remoteUpdates, undefined);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      state.currentRemoteStatus = remoteStatusWithPr;
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(remoteUpdates);
      const localCalls = state.localStatusCalls;
      const remoteCalls = state.remoteStatusCalls;

      state.currentRemoteStatus = baseRemoteStatus;
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(remoteUpdates);
      assert.equal(state.remoteStatusCalls, remoteCalls + 1);
      assert.equal(state.localStatusCalls, localCalls);

      state.refSnapshot = "fetched";
      state.currentRemoteStatus = remoteStatusWithPr;
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(remoteUpdates);
      assert.equal(state.localStatusCalls, localCalls + 1);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("reads Changes totals only while a subscriber shows them", () => {
    const branchChanges = { baseRef: "origin/main", insertions: 3, deletions: 1 };
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: { ...baseLocalStatus, branchChanges },
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      localStatusBranchChanges: [],
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const paletteEvents = yield* Queue.unbounded<VcsStatusStreamEvent>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => Queue.offer(paletteEvents, event)),
        Effect.forkScoped,
      );
      const paletteSnapshot = yield* Queue.take(paletteEvents);
      assert.strictEqual(paletteSnapshot._tag, "snapshot");
      if (paletteSnapshot._tag === "snapshot") {
        assert.isUndefined(paletteSnapshot.local.branchChanges);
      }
      yield* broadcaster.refreshLocalStatus("/repo");
      assert.deepStrictEqual(state.localStatusBranchChanges, [false, false]);

      const headerScope = yield* Scope.make();
      const headerEvents = yield* Queue.unbounded<VcsStatusStreamEvent>();
      yield* broadcaster.streamStatus({ cwd: "/repo" }).pipe(
        Stream.runForEach((event) => Queue.offer(headerEvents, event)),
        Effect.forkIn(headerScope),
      );
      const headerSnapshot = yield* Queue.take(headerEvents);
      assert.strictEqual(headerSnapshot._tag, "snapshot");
      if (headerSnapshot._tag === "snapshot") {
        assert.deepStrictEqual(headerSnapshot.local.branchChanges, branchChanges);
      }
      const paletteUpdate = yield* Queue.take(paletteEvents);
      assert.strictEqual(paletteUpdate._tag, "localUpdated");
      if (paletteUpdate._tag === "localUpdated") {
        assert.deepStrictEqual(paletteUpdate.local.branchChanges, branchChanges);
      }
      // The header's first remote poll also rereads local status.
      while ((yield* Queue.take(headerEvents))._tag !== "remoteUpdated") {}
      const turnEnd = yield* broadcaster.refreshLocalStatus("/repo");
      assert.deepStrictEqual(turnEnd.branchChanges, branchChanges);

      yield* Scope.close(headerScope, Exit.void);
      yield* broadcaster.refreshLocalStatus("/repo");
      assert.deepStrictEqual(state.localStatusBranchChanges, [
        false,
        false,
        true,
        true,
        true,
        false,
      ]);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("a light refresh that a header joins mid-read publishes Changes totals", () => {
    const branchChanges = { baseRef: "origin/main", insertions: 3, deletions: 1 };
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: { ...baseLocalStatus, branchChanges },
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      localStatusBranchChanges: [],
      fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const subscribeHeader = Effect.fn("subscribeHeader")(function* (scope: Scope.Scope) {
        const events = yield* Queue.unbounded<VcsStatusStreamEvent>();
        yield* broadcaster.streamStatus({ cwd: "/repo" }).pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkIn(scope, { startImmediately: true }),
        );
        return events;
      });
      const firstHeader = yield* Scope.make();
      const firstEvents = yield* subscribeHeader(firstHeader);
      while ((yield* Queue.take(firstEvents))._tag !== "remoteUpdated") {}
      yield* Scope.close(firstHeader, Exit.void);

      const readStarted = yield* Deferred.make<void>();
      const finishRead = yield* Deferred.make<void>();
      state.beforeLocalStatus = Deferred.succeed(readStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishRead)),
      );
      const turnEnd = yield* broadcaster.refreshLocalStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(readStarted);
      // Starting immediately registers the header's demand before it waits behind the read.
      const secondEvents = yield* subscribeHeader(yield* Scope.make());
      yield* Deferred.succeed(finishRead, undefined);
      const snapshot = yield* Queue.take(secondEvents);
      assert.strictEqual(snapshot._tag, "snapshot");
      if (snapshot._tag === "snapshot") {
        assert.deepStrictEqual(snapshot.local.branchChanges, branchChanges);
      }

      assert.deepStrictEqual((yield* Fiber.join(turnEnd)).branchChanges, branchChanges);
      assert.deepStrictEqual(state.localStatusBranchChanges?.slice(-2), [false, true]);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("an explicit refresh reads local totals after the fetch", () => {
    return Effect.gen(function* () {
      const fetchStarted = yield* Deferred.make<void>();
      const finishFetch = yield* Deferred.make<void>();
      let local: VcsStatusLocalResult = {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 745, deletions: 24 },
      };
      let cachedLocal: VcsStatusLocalResult | undefined;
      let refSnapshot = "before";
      const readLocalStatus = () => Effect.sync(() => (cachedLocal ??= local));
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: readLocalStatus,
            invalidateStatus: () =>
              Effect.sync(() => {
                cachedLocal = undefined;
              }),
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                cachedLocal = undefined;
              }),
            currentBranch: () => Effect.succeed(baseLocalStatus.refName),
            invalidateRemoteStatus: () => Effect.void,
            readLocalStatusRefSnapshot: () => Effect.sync(() => refSnapshot),
            readRefSnapshot: () => Effect.sync(() => refSnapshot),
            remoteStatus: () =>
              Deferred.succeed(fetchStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishFetch)),
                Effect.as(baseRemoteStatus),
              ),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
        yield* Deferred.await(fetchStarted);
        // Another reader can refill the local cache while fetch is still running.
        yield* readLocalStatus();
        local = {
          ...baseLocalStatus,
          branchChanges: { baseRef: "origin/main", insertions: 0, deletions: 0 },
        };
        refSnapshot = "after";
        yield* Deferred.succeed(finishFetch, undefined);
        const status = yield* Fiber.join(refresh);
        assert.deepStrictEqual(status.branchChanges, local.branchChanges);
      }).pipe(Effect.provide(layerTest));
    });
  });

  it.effect("publishes local changes before a remote error and propagates that error", () => {
    const remoteError = new GitManagerError({
      operation: "VcsStatusBroadcaster.remoteStatus",
      cwd: "/repo",
      detail: "The controlled remote lookup failed.",
    });
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const published = yield* Deferred.make<VcsStatusLocalResult>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "localUpdated") return Deferred.succeed(published, event.local);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      state.remoteStatusError = remoteError;
      const refresh = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(
          Effect.result,
          Effect.ensuring(Deferred.succeed(completed, undefined)),
          Effect.forkScoped,
        );
      yield* Deferred.await(started);
      assert.isFalse(yield* Deferred.isDone(completed));
      const pending = Option.getOrThrow(
        yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/repo", includeRemote: false })),
      );
      assert.equal(pending._tag, "snapshot");
      if (pending._tag === "snapshot") assert.isTrue(pending.local.hasWorkingTreeChanges);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(refresh);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure, remoteError);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.isTrue(cached.hasWorkingTreeChanges);
      assert.deepStrictEqual(cached.pr, remoteStatusWithPr.pr);
      assert.deepStrictEqual(yield* Deferred.await(published), state.currentLocalStatus);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect.each(["getStatus", "refreshStatus", "autoPull", "autoPullFailure"] as const)(
    "%s keeps response parts consistent when local state changes after the remote cache write",
    (operation) => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 3, behindCount: 5 },
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
      };
      const autoPull = operation === "autoPull" || operation === "autoPullFailure";
      if (autoPull) {
        state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: true };
        state.currentRemoteStatus = { ...remoteStatusWithPr, aheadCount: 0, behindCount: 5 };
        state.pullCurrentBranch = () =>
          operation === "autoPullFailure"
            ? Effect.fail(
                new GitCommandError({
                  operation: "test.pull",
                  command: "pull",
                  cwd: "/repo",
                  detail: "Pull failed.",
                }),
              )
            : Effect.succeed({
                status: "pulled",
                refName: "feature/status-broadcast",
                upstreamRef: "origin/main",
              });
      }
      const layerTest = layerTestFor(state).pipe(
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: () => Effect.succeed(autoPull),
          }),
        ),
      );
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        let switched = false;
        let remoteWritten = false;
        const writeCompleted = yield* Deferred.make<void>();
        const localRefresh = yield* Effect.gen(function* () {
          yield* Deferred.await(writeCompleted);
          state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next-status" };
          yield* broadcaster.refreshLocalStatus("/repo");
          switched = true;
        }).pipe(Effect.forkScoped);
        const scheduler = new Scheduler.MixedScheduler();
        const shouldYield = scheduler.shouldYield.bind(scheduler);
        scheduler.shouldYield = (fiber) => (remoteWritten && !switched) || shouldYield(fiber);
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (
                options.name !== "VcsStatusBroadcaster.updateCachedRemoteStatus" ||
                remoteWritten
              ) {
                return;
              }
              // Yield this reader after its write until the local refresh finishes.
              remoteWritten = true;
              Deferred.doneUnsafe(writeCompleted, Effect.void);
            };
            return span;
          },
        });
        const status = yield* (
          operation === "getStatus"
            ? broadcaster.getStatus({ cwd: "/repo" })
            : broadcaster.refreshStatus("/repo")
        ).pipe(Effect.withTracer(tracer), Effect.provideService(Scheduler.Scheduler, scheduler));
        yield* Fiber.join(localRefresh);
        assert.isTrue(switched);
        assert.equal(status.refName, "feature/next-status");
        assert.isNull(status.pr);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
      }).pipe(Effect.provide(layerTest));
    },
  );

  it.effect("releases remote demand while passive observers remain", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let remoteInterruptedDeferred: Deferred.Deferred<void, never> | null = null;
    let remoteStartedDeferred: Deferred.Deferred<void, never> | null = null;
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
            }).pipe(
              Effect.andThen(
                remoteStartedDeferred
                  ? Deferred.succeed(remoteStartedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                remoteInterruptedDeferred
                  ? Deferred.succeed(remoteInterruptedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const remoteInterrupted = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      remoteInterruptedDeferred = remoteInterrupted;
      remoteStartedDeferred = remoteStarted;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const passiveSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(passiveSnapshot, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(passiveSnapshot);
      assert.equal(state.remoteStatusCalls, 0);
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(remoteStarted);

      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(Option.isNone(yield* Deferred.poll(remoteInterrupted)));

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(remoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("refreshes requested during a refresh share one follow-up refresh", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const fetchStarted = yield* Deferred.make<void>();
      const finishFetch = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(fetchStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishFetch)),
      );
      const first = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(fetchStarted);
      // Every read after the first sees a PR, so a caller that reused the
      // first refresh would get a status from before its own request.
      state.beforeRemoteStatus = Effect.sync(() => {
        state.currentRemoteStatus = remoteStatusWithPr;
      });
      const later = yield* Effect.all(
        [broadcaster.refreshStatus("/repo"), broadcaster.refreshStatus("/repo")],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(finishFetch, undefined);

      assert.isNull((yield* Fiber.join(first)).pr);
      const [second, third] = yield* Fiber.join(later);
      assert.deepStrictEqual(second.pr, remoteStatusWithPr.pr);
      assert.deepStrictEqual(third.pr, remoteStatusWithPr.pr);
      assert.equal(state.remoteStatusCalls, 2);

      yield* broadcaster.refreshStatus("/repo");
      assert.equal(state.remoteStatusCalls, 3);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("a failed refresh releases interrupted waiters and runs the shared follow-up", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          Effect.fail(
            new GitManagerError({
              operation: "VcsStatusBroadcaster.test",
              cwd: "/repo",
              detail: "remote status failed",
            }),
          ),
        ),
      );
      const first = yield* broadcaster.refreshStatus("/repo").pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(started);
      const interrupted = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const remaining = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Fiber.interrupt(interrupted);
      state.beforeRemoteStatus = Effect.void;
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(first)));
      assert.deepStrictEqual((yield* Fiber.join(remaining)).pr, remoteStatusWithPr.pr);
      assert.equal(state.remoteStatusCalls, 1);
      yield* broadcaster.refreshStatus("/repo");
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.provide(layerTestFor(state)));
  });
});

const newState = (): Parameters<typeof layerTestFor>[0] => ({
  fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
  currentLocalStatus: baseLocalStatus,
  currentRemoteStatus: null,
  localStatusCalls: 0,
  remoteStatusCalls: 0,
  localInvalidationCalls: 0,
  remoteInvalidationCalls: 0,
});
it.effect("detail join during invalidation must get fresh totals", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const oldScope = yield* Scope.make();
    const old = yield* Stream.toPull(b.streamStatus({ cwd: "/repo", includeRemote: false })).pipe(
      Scope.provide(oldScope),
    );
    yield* old;
    yield* Scope.close(oldScope, Exit.void);
    state.currentLocalStatus = {
      ...baseLocalStatus,
      workingTree: { files: [], insertions: 42, deletions: 0 },
    };
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    state.beforeInvalidate = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(resume)),
    );
    const refresh = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const snapshotFiber = yield* Stream.runHead(
      b.streamStatus({ cwd: "/repo", includeRemote: false }),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(refresh);
    assert.deepEqual(
      yield* Fiber.join(snapshotFiber),
      Option.some({ _tag: "snapshot" as const, local: state.currentLocalStatus, remote: null }),
    );
  }).pipe(Effect.provide(layerTestFor(state)));
});
it.effect("serializes branch reads with detailed refresh publication", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    state.branchRead = () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
        Effect.as("old"),
      );
    const older = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    state.currentLocalStatus = { ...baseLocalStatus, refName: "new" };
    const newer = yield* b
      .refreshLocalStatus("/repo")
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(older);
    yield* Fiber.join(newer);
    state.branchRead = () => Effect.succeed("new");
    const result = yield* b
      .streamStatus({ cwd: "/repo", includeRemote: false })
      .pipe(Stream.runHead, Effect.flatMap(Effect.fromOption));
    assert.equal(result._tag === "snapshot" && result.local.refName, "new");
    assert.equal(state.localStatusCalls, 1);
  }).pipe(Effect.provide(layerTestFor(state)));
});

it.effect("publishes overlapping branch reads in checkout order", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const branches = yield* Stream.toPull(b.streamBranchStatus({ cwd: "/repo" }));
    yield* branches;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let reads = 0;
    state.branchRead = () =>
      ++reads === 1
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as("old"),
          )
        : Effect.succeed("new");
    const older = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const newer = yield* b
      .refreshBranchStatus({ cwd: "/repo" })
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(older);
    yield* Fiber.join(newer);
    assert.deepEqual(yield* branches, [
      { refName: "old", isRepo: true },
      { refName: "new", isRepo: true },
    ]);
  }).pipe(Effect.provide(layerTestFor(state)));
});

it.effect("does not replay older queued branches after a new subscriber snapshot", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const values = yield* Queue.unbounded<VcsBranchStatus>();
    let reads = 0;
    state.branchRead = () =>
      ++reads === 1
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as("old"),
          )
        : Effect.succeed("new");
    const older = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const subscriber = yield* b.streamBranchStatus({ cwd: "/repo" }).pipe(
      Stream.tap((value) => Queue.offer(values, value)),
      Stream.take(2),
      Stream.runDrain,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(older);
    assert.deepEqual(yield* Queue.take(values), { refName: "new", isRepo: true });
    state.branchRead = () => Effect.succeed("latest");
    yield* b.refreshBranchStatus({ cwd: "/repo" });
    assert.deepEqual(yield* Queue.take(values), { refName: "latest", isRepo: true });
    yield* Fiber.join(subscriber);
  }).pipe(Effect.provide(layerTestFor(state)));
});
