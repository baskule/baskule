/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- verifies the native request Promise and its retained event while Effect authentication and finalizers wait. */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { HttpServerResponse } from "effect/http";
import { expect, it, vi } from "vite-plus/test";

import { handleUpgrade } from "./transport.ts";

it("rejects an upgrade on a disposed server without running its app", async () => {
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = {};
      1 = {};
    },
  );
  const scope = Scope.makeUnsafe();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  const authenticate = vi.fn(() => HttpServerResponse.empty({ status: 401 }));
  const lifetimes: Promise<unknown>[] = [];
  try {
    const response = await handleUpgrade(
      {
        app: Effect.sync(authenticate),
        context: Context.empty(),
        handler: async () => new Response(),
      },
      new Request("http://space/ws", { headers: { upgrade: "websocket" } }),
      {
        scope,
        waitUntil: (promise) => {
          lifetimes.push(promise);
        },
        onOpen: () => () => {},
      },
    );
    expect(response.status).toBe(503);
    expect(authenticate).not.toHaveBeenCalled();
  } finally {
    await Promise.all(lifetimes);
    vi.unstubAllGlobals();
  }
});

it("interrupts authentication before the server scope finishes closing", async () => {
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = {};
      1 = {};
    },
  );
  const scope = Scope.makeUnsafe();
  const entered = Deferred.makeUnsafe<void>();
  const authenticate = Deferred.makeUnsafe<void>();
  const events: string[] = [];
  const lifetimes: Promise<unknown>[] = [];
  const app = Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        events.push("cleaned");
      }),
    );
    yield* Deferred.succeed(entered, undefined);
    yield* Deferred.await(authenticate);
    events.push("authenticated");
    return HttpServerResponse.empty({ status: 401 });
  });
  const hooks = {
    scope,
    waitUntil: (promise: Promise<unknown>) => {
      lifetimes.push(promise);
    },
    onOpen: () => () => {},
  };
  const response = handleUpgrade(
    { app, context: Context.empty(), handler: async () => new Response() },
    new Request("http://space/ws", { headers: { upgrade: "websocket" } }),
    hooks,
  );
  try {
    await Effect.runPromise(Deferred.await(entered));
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect([...events]).toEqual(["cleaned"]);
    expect((await response).status).toBe(503);
  } finally {
    await Effect.runPromise(Deferred.succeed(authenticate, undefined));
    await response;
    await Promise.all(lifetimes);
    vi.unstubAllGlobals();
  }
});

it.each(["response", "disposal"])(
  "retains the upgrade event through %s cleanup",
  async (ending) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = {};
        1 = {};
      },
    );
    const entered = Deferred.makeUnsafe<void>();
    const scope = Scope.makeUnsafe();
    const authenticate = Deferred.makeUnsafe<void>();
    const cleanupStarted = Deferred.makeUnsafe<void>();
    const cleanup = Deferred.makeUnsafe<void>();
    const lifetimes: Promise<unknown>[] = [];
    let closed = false;
    let closing: Promise<void> | undefined;
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
        scope,
        waitUntil: (promise) => {
          lifetimes.push(promise);
        },
        onOpen: () => () => {},
      },
    );
    try {
      await Effect.runPromise(Deferred.await(entered));
      expect(vi.getTimerCount()).toBe(1);
      if (ending === "response") {
        await Effect.runPromise(Deferred.succeed(authenticate, undefined));
        expect((await response).status).toBe(401);
      } else {
        closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
          closed = true;
        });
      }
      await Effect.runPromise(Deferred.await(cleanupStarted));
      expect(vi.getTimerCount()).toBe(1);
      expect(closed).toBe(false);
    } finally {
      await Effect.runPromise(Deferred.succeed(authenticate, undefined));
      await Effect.runPromise(Deferred.succeed(cleanup, undefined));
      await response;
      await Promise.all(lifetimes);
      await closing;
      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  },
);
