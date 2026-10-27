import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import type { BaskuleSession } from "./session";

const harness = vi.hoisted(() => ({
  session: { status: "loading" } as BaskuleSession,
  listeners: new Set<() => void>(),
  cache: new Map<string, string>(),
  discover: vi.fn<typeof import("./registrations").fetchSpaceEnvironmentId>(),
}));
vi.mock("./session", () => ({
  loadBaskuleSession: async () => {},
  readBaskuleSession: () => harness.session,
  subscribeBaskuleSession: (listener: () => void) => {
    harness.listeners.add(listener);
    return () => {
      harness.listeners.delete(listener);
    };
  },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => harness.cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      harness.cache.set(key, value);
    },
  },
}));
vi.mock("./registrations", async (original) => ({
  ...(await original<typeof import("./registrations")>()),
  fetchSpaceEnvironmentId: harness.discover,
}));

function connection(userId: string): BaskuleSession {
  return {
    status: "signed-in",
    kind: "authenticated",
    serverUrl: "https://baskule.example",
    token: userId,
    me: {
      authentication: { mode: "authenticated", password: true, providers: [] },
      voiceInput: false,
      user: { id: userId, name: userId, email: `${userId}@example.com`, role: "member" },
      organization: { id: "org", name: "Org" },
      spaces: [{ id: "team", kind: "team", role: "member", name: "Team", base: "/s/team" }],
    },
  };
}

it.effect(
  "removes old account registrations before the same team environment gets new credentials",
  () =>
    Effect.gen(function* () {
      harness.discover.mockReset().mockResolvedValue("shared-team-environment");
      harness.session = connection("a");
      harness.cache.clear();
      const { layerSpaceConnectionSource } = yield* Effect.promise(() => import("./spaces"));
      const batches: Array<Array<{ token: string; environmentId: string }>> = [];
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        yield* source.registrations.pipe(
          Stream.take(3),
          Stream.runForEach((registrations) =>
            Effect.sync(() => {
              batches.push(
                registrations.map((entry) => ({
                  token:
                    entry._tag === "BearerConnectionRegistration" ? entry.credential.token : "",
                  environmentId: entry.target.environmentId,
                })),
              );
              if (batches.length === 1) {
                harness.session = connection("b");
                for (const listener of harness.listeners) listener();
              }
            }),
          ),
        );
      }).pipe(Effect.provide(layerSpaceConnectionSource));
      expect(batches).toEqual([
        [{ token: "a", environmentId: "shared-team-environment" }],
        [],
        [{ token: "b", environmentId: "shared-team-environment" }],
      ]);
    }),
);

it.live("connects a replacement account before an old descriptor request settles", () =>
  Effect.gen(function* () {
    harness.session = connection("pending-a");
    harness.discover.mockReset().mockResolvedValue("shared-team-environment");
    const entered = Promise.withResolvers<void>();
    const finishDescriptor = Promise.withResolvers<string | null>();
    let oldSignal: AbortSignal | undefined;
    harness.discover.mockImplementation(async (_server, token, space, _fetch, signal) => {
      if (token === "pending-a" && space.id === "pending-space") {
        oldSignal = signal;
        entered.resolve();
        return finishDescriptor.promise;
      }
      return "shared-team-environment";
    });
    const { layerSpaceConnectionSource } = yield* Effect.promise(() => import("./spaces"));
    const batches: string[][] = [];
    const observation = yield* Effect.forkChild(
      Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        yield* source.registrations.pipe(
          Stream.take(3),
          Stream.runForEach((registrations) =>
            Effect.sync(() => {
              batches.push(
                registrations.map((entry) =>
                  entry._tag === "BearerConnectionRegistration" ? entry.credential.token : "",
                ),
              );
              if (batches.length === 1 && harness.session.status === "signed-in") {
                harness.session = {
                  ...harness.session,
                  me: {
                    ...harness.session.me,
                    spaces: [
                      ...harness.session.me.spaces,
                      {
                        id: "pending-space",
                        kind: "team",
                        role: "member",
                        name: "Pending",
                        base: "/s/pending-space",
                      },
                    ],
                  },
                };
                for (const listener of harness.listeners) listener();
              }
            }),
          ),
        );
      }).pipe(Effect.provide(layerSpaceConnectionSource), Effect.timeout("5 seconds")),
    );
    try {
      yield* Effect.promise(() => entered.promise);
      harness.session = connection("pending-b");
      for (const listener of harness.listeners) listener();
      yield* Fiber.join(observation);
      expect(batches).toEqual([["pending-a"], [], ["pending-b"]]);
      expect(oldSignal?.aborted).toBe(true);
    } finally {
      finishDescriptor.resolve("stale-a-environment");
    }
  }),
);
