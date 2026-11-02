import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import { expect, it, vi } from "vite-plus/test";

import { handleUpgrade } from "./transport.ts";

it("retains the upgrade event through authentication and scope cleanup", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = {};
      1 = {};
    },
  );
  const entered = Deferred.makeUnsafe<void>();
  const authenticate = Deferred.makeUnsafe<void>();
  const cleanupStarted = Deferred.makeUnsafe<void>();
  const cleanup = Deferred.makeUnsafe<void>();
  const lifetimes: Promise<unknown>[] = [];
  const app = Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanup))),
    );
    yield* Deferred.succeed(entered, undefined);
    yield* Deferred.await(authenticate);
    return HttpServerResponse.empty({ status: 401 });
  });
  const response = handleUpgrade(
    { app, context: Context.empty(), handler: async () => new Response() },
    new Request("http://space/ws", { headers: { upgrade: "websocket" } }),
    {
      waitUntil: (promise) => {
        lifetimes.push(promise);
      },
      onOpen: () => () => {},
    },
  );
  try {
    await Effect.runPromise(Deferred.await(entered));
    expect(vi.getTimerCount()).toBe(1);
    await Effect.runPromise(Deferred.succeed(authenticate, undefined));
    expect((await response).status).toBe(401);
    await Effect.runPromise(Deferred.await(cleanupStarted));
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    await Effect.runPromise(Deferred.succeed(authenticate, undefined));
    await Effect.runPromise(Deferred.succeed(cleanup, undefined));
    await response;
    await Promise.all(lifetimes);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
