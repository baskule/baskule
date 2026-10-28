// baskule: spaces use same-origin PrimaryConnectionRegistration entries under /s/<id>/.
// The session cookie authenticates them without pairing. Personal is registered first.
import { PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import {
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { deriveWsBaseUrl } from "@t3tools/client-runtime/environment";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { useSyncExternalStore } from "react";

import type { BaskuleSpace } from "./api";
import { spaceBaseUrl } from "./api";
import {
  readBaskuleMe,
  refreshBaskuleMe,
  subscribeBaskuleMe,
  watchBaskuleSession,
} from "./session";

/** Retries spaces whose environment did not answer yet (a cell waking up). */
const RETRY_INTERVAL = "5 seconds";

export interface SpaceEnvironment {
  readonly space: BaskuleSpace;
  readonly environmentId: EnvironmentId;
}

/** Membership order is personal first; connection arrival must not change the picker order. */
export function orderEnvironmentsBySpace<T extends { readonly environmentId: EnvironmentId }>(
  environments: readonly T[],
  spaces: readonly SpaceEnvironment[],
): T[] {
  const order = new Map(spaces.map(({ environmentId }, index) => [environmentId, index]));
  return environments.toSorted(
    (a, b) =>
      (order.get(a.environmentId) ?? spaces.length) - (order.get(b.environmentId) ?? spaces.length),
  );
}

/** Keep space order stable while preserving the discussion order within each space. */
export function groupThreadsBySpace<T extends { readonly environmentId: EnvironmentId }>(
  threads: readonly T[],
  environments: readonly SpaceEnvironment[],
): T[] {
  const groups = new Map<EnvironmentId, T[]>();
  for (const { environmentId } of environments) groups.set(environmentId, []);
  for (const thread of threads) {
    const group = groups.get(thread.environmentId);
    if (group) group.push(thread);
    else groups.set(thread.environmentId, [thread]);
  }
  return [...groups.values()].flat();
}

let spaceEnvironments: ReadonlyArray<SpaceEnvironment> = [];
const listeners = new Set<() => void>();

function publish(next: ReadonlyArray<SpaceEnvironment>) {
  if (JSON.stringify(next) === JSON.stringify(spaceEnvironments)) return;
  spaceEnvironments = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const readSpaceEnvironments = () => spaceEnvironments;

export function useSpaceEnvironments(): ReadonlyArray<SpaceEnvironment> {
  return useSyncExternalStore(subscribe, readSpaceEnvironments, readSpaceEnvironments);
}

/** Connection completion order must never turn a team space into the default for a new chat. */
export function primarySpaceEnvironmentId(
  spaces: ReadonlyArray<SpaceEnvironment>,
  registered: ReadonlyMap<EnvironmentId, unknown>,
): EnvironmentId | null {
  const personal = spaces.find(({ space }) => space.kind === "personal");
  return personal && registered.has(personal.environmentId) ? personal.environmentId : null;
}

export function spaceForEnvironment(
  environments: ReadonlyArray<SpaceEnvironment>,
  environmentId: EnvironmentId | null | undefined,
): BaskuleSpace | null {
  if (!environmentId) return null;
  return environments.find((entry) => entry.environmentId === environmentId)?.space ?? null;
}

/** The space of an environment, or null outside the Baskule hosted build. */
export function useSpaceForEnvironment(
  environmentId: EnvironmentId | null | undefined,
): BaskuleSpace | null {
  return spaceForEnvironment(useSpaceEnvironments(), environmentId);
}

export function spaceRegistration(
  origin: string,
  space: BaskuleSpace,
  environmentId: EnvironmentId,
  socketOrigin = origin,
): PrimaryConnectionRegistration {
  const httpBaseUrl = spaceBaseUrl(origin, space.base);
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: space.name,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(spaceBaseUrl(socketOrigin, space.base)),
    }),
  });
}

/** The environment id of a space is its server's descriptor; it never changes, so it is cached. */
const environmentIdBySpace = new Map<string, EnvironmentId>();

const resolveEnvironmentId = (origin: string, space: BaskuleSpace) => {
  const cached = environmentIdBySpace.get(space.id);
  if (cached !== undefined) return Effect.succeedSome(cached);
  return fetchRemoteEnvironmentDescriptor({ httpBaseUrl: spaceBaseUrl(origin, space.base) }).pipe(
    Effect.map((descriptor) => {
      environmentIdBySpace.set(space.id, descriptor.environmentId);
      return Option.some(descriptor.environmentId);
    }),
    Effect.tapError((error) =>
      Effect.logWarning("Could not reach a space.", { spaceId: space.id, error }),
    ),
    Effect.orElseSucceed(() => Option.none<EnvironmentId>()),
    Effect.provide(FetchHttpClient.layer),
  );
};

/** A confirmed membership loss must also leave the open chat, not just remove its sidebar row. */
export function activeSpaceWasRemoved(
  previous: ReadonlyArray<SpaceEnvironment>,
  allowed: ReadonlyArray<BaskuleSpace>,
  pathname: string,
): boolean {
  return previous.some(
    ({ space, environmentId }) =>
      pathname.startsWith(`/${encodeURIComponent(environmentId)}/`) &&
      !allowed.some((entry) => entry.id === space.id),
  );
}

const buildRegistrations = Effect.gen(function* () {
  const me = readBaskuleMe();
  if (me === null) {
    publish([]);
    return [] as ReadonlyArray<PlatformConnectionRegistration>;
  }
  if (activeSpaceWasRemoved(spaceEnvironments, me.spaces, window.location.pathname)) {
    // A full navigation clears the mounted conversation and its actionable composer immediately.
    yield* Effect.try(() =>
      window.sessionStorage.setItem("baskule:space-access-removed", "1"),
    ).pipe(Effect.ignore);
    window.location.replace("/");
    return [] as ReadonlyArray<PlatformConnectionRegistration>;
  }
  const origin = window.location.origin;
  const resolved = yield* Effect.forEach(
    me.spaces,
    (space) =>
      resolveEnvironmentId(origin, space).pipe(
        Effect.map(Option.map((environmentId) => ({ space, environmentId }))),
      ),
    { concurrency: "unbounded" },
  );
  const reachable = resolved.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
  publish(reachable);
  return reachable.map(({ space, environmentId }) =>
    spaceRegistration(
      origin,
      space,
      environmentId,
      window.desktopBridge?.getBaskuleServer?.() ?? origin,
    ),
  ) as ReadonlyArray<PlatformConnectionRegistration>;
});

const sessionChanges = Stream.callback<void>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => subscribeBaskuleMe(() => Queue.offerUnsafe(queue, undefined))),
    (unsubscribe) => Effect.sync(unsubscribe),
  ).pipe(Effect.asVoid),
);

export const layerSpaceConnectionSource = Layer.effect(
  PlatformConnectionSource.PlatformConnectionSource,
  Effect.gen(function* () {
    watchBaskuleSession();
    if (readBaskuleMe() === null) {
      yield* Effect.promise(() => refreshBaskuleMe().catch(() => null));
    }
    return PlatformConnectionSource.PlatformConnectionSource.of({
      registrations: Stream.merge(sessionChanges, Stream.tick(RETRY_INTERVAL)).pipe(
        Stream.mapEffect(() => buildRegistrations),
        // A tick with nothing new must not re-run reconciliation work downstream.
        Stream.changesWith(
          (left, right) =>
            left.length === right.length &&
            left.every(
              (registration, index) =>
                JSON.stringify(registration) === JSON.stringify(right[index]),
            ),
        ),
      ),
    });
  }),
);
