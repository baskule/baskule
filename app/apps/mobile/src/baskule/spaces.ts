/**
 * Registers one T3 environment per Baskule space of the signed-in person (architecture E9/E10),
 * like the web client's `apps/web/src/baskule/spaces.ts`, but with the session token instead of a
 * cookie (`front-session` profiles, see ./registrations.ts).
 */
import { useSyncExternalStore } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import type { BaskuleSpace } from "./api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PlatformConnectionRegistration } from "@t3tools/client-runtime/connection";
import { PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { fetchSpaceEnvironmentId, spaceRegistration } from "./registrations";
import { loadBaskuleSession, readBaskuleSession, subscribeBaskuleSession } from "./session";

export type SpaceEnvironment = Pick<BaskuleSpace, "kind"> & {
  readonly spaceId: string;
  readonly environmentId: EnvironmentId;
};
let spaceEnvironments: ReadonlyArray<SpaceEnvironment> = [];
let mappingOwner: string | null = null;
const mappingListeners = new Set<() => void>();
function sessionOwner() {
  const session = readBaskuleSession();
  return session.status === "signed-in"
    ? `${session.serverUrl} ${session.me.user.id} ${session.token}`
    : null;
}
function publishMapping(owner: string | null, mapping: ReadonlyArray<SpaceEnvironment>) {
  mappingOwner = owner;
  spaceEnvironments = mapping;
  for (const listener of mappingListeners) listener();
}
subscribeBaskuleSession(() => {
  if (mappingOwner !== sessionOwner()) publishMapping(null, []);
});
export function useSpaceEnvironments() {
  return useSyncExternalStore(
    (listener) => {
      mappingListeners.add(listener);
      return () => {
        mappingListeners.delete(listener);
      };
    },
    () => spaceEnvironments,
    () => spaceEnvironments,
  );
}

/** Retries spaces whose environment did not answer yet (a cell waking up, or no network). */
const RETRY_INTERVAL = "10 seconds";
const CACHE_KEY = "baskule.space-environments";

/** A space's environment id never changes; it is kept on the device so spaces show offline. */
let environmentIds: Record<string, string> | null = null;

async function readCache(): Promise<Record<string, string>> {
  if (environmentIds !== null) return environmentIds;
  try {
    environmentIds = JSON.parse((await AsyncStorage.getItem(CACHE_KEY)) ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    environmentIds = {};
  }
  return environmentIds;
}

async function buildRegistrations(
  signal: AbortSignal,
): Promise<ReadonlyArray<PlatformConnectionRegistration>> {
  const session = readBaskuleSession();
  if (session.status !== "signed-in") return [];
  const owner = sessionOwner();
  const cache = await readCache();
  const mapping: SpaceEnvironment[] = [];
  const registrations: Array<PlatformConnectionRegistration> = [];
  let changed = false;
  for (const space of session.me.spaces) {
    if (signal.aborted) return [];
    const key = `${session.serverUrl} ${session.me.user.id} ${space.id}`;
    let environmentId: string | null = cache[key] ?? null;
    if (environmentId === null) {
      environmentId = await fetchSpaceEnvironmentId(
        session.serverUrl,
        session.token,
        space,
        fetch,
        signal,
      );
      if (signal.aborted) return [];
      if (environmentId !== null) {
        cache[key] = environmentId;
        changed = true;
      }
    }
    if (environmentId !== null) {
      mapping.push({
        spaceId: space.id,
        kind: space.kind,
        environmentId: EnvironmentId.make(environmentId),
      });
      registrations.push(
        spaceRegistration({
          serverUrl: session.serverUrl,
          token: session.token,
          space,
          environmentId,
        }),
      );
    }
  }
  if (changed) await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache)).catch(() => undefined);
  if (signal.aborted || sessionOwner() !== owner) return [];
  publishMapping(owner, mapping);
  return registrations;
}

const sessionChanges = Stream.callback<void>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => subscribeBaskuleSession(() => Queue.offerUnsafe(queue, undefined))),
    (unsubscribe) => Effect.sync(unsubscribe),
  ).pipe(Effect.asVoid),
);

export const layerSpaceConnectionSource = Layer.effect(
  PlatformConnectionSource.PlatformConnectionSource,
  Effect.gen(function* () {
    yield* Effect.promise(() => loadBaskuleSession());
    let previousOwner: string | null | undefined;
    return PlatformConnectionSource.PlatformConnectionSource.of({
      registrations: Stream.merge(Stream.make(undefined), sessionChanges).pipe(
        Stream.map(sessionOwner),
        Stream.changes,
        Stream.switchMap((owner) => {
          const changedAccount = previousOwner !== undefined && previousOwner !== owner;
          previousOwner = owner;
          const next = Stream.merge(
            Stream.make(undefined),
            Stream.merge(sessionChanges, Stream.tick(RETRY_INTERVAL)),
          ).pipe(Stream.flatMap(() => Stream.fromEffect(Effect.promise(buildRegistrations))));
          const clearPreviousAccount = Stream.succeed<
            ReadonlyArray<PlatformConnectionRegistration>
          >([]);
          return changedAccount ? Stream.concat(clearPreviousAccount, next) : next;
        }),
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
