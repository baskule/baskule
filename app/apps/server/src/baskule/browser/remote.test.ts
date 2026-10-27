import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ThreadId } from "@t3tools/contracts";
import { RemoteState, makeManager, stateLayer } from "./remote.ts";
const config = { url: "http://computerd", token: "private-test-token", spaceId: "space-a" };
afterEach(() => vi.unstubAllGlobals());
it("lists a sleeping browser without issuing a wake/action request", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return Response.json({ result: { sessions: [], serverEpoch: "idle", revision: 0 } });
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const manager = yield* makeManager;
      return yield* manager.list({ threadId: ThreadId.make("thread-a") });
    }).pipe(Effect.provide(stateLayer(config)), Effect.scoped),
  );
  expect(result.sessions).toEqual([]);
  expect(calls).toEqual(["http://computerd/v1/spaces/space-a/browser/peek?threadId=thread-a"]);
});
it("treats a stopped/unreachable computer as empty without starting it", async () => {
  const fetcher = vi.fn(async () => {
    throw new Error("computer asleep");
  });
  vi.stubGlobal("fetch", fetcher);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const manager = yield* makeManager;
      return yield* manager.list({ threadId: ThreadId.make("thread-a") });
    }).pipe(Effect.provide(stateLayer(config)), Effect.scoped),
  );
  expect(result.sessions).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("boots on explicit action before subscribing, then dispatches after stream connects", async () => {
  const order: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("events")) {
      order.push("events");
      return new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () => controller.close());
          },
        }),
      );
    }
    const request = JSON.parse(String(init.body));
    order.push(request.method);
    return Response.json({ result: request.method === "open" ? { tabId: "tab" } : null });
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* RemoteState;
      yield* Effect.promise(() =>
        state.call("reportProfiles", { profiles: [], defaultProfileId: "default" }),
      );
      expect(order).toEqual([]);
      const result = yield* Effect.promise(() =>
        state.call("open", { threadId: "thread-a", url: "https://example.com" }),
      );
      expect(result).toEqual({ tabId: "tab" });
    }).pipe(Effect.provide(stateLayer(config)), Effect.scoped),
  );
  expect(order).toEqual(["reportProfiles", "events", "open"]);
});

it("closing a deleted chat's tabs never wakes a sleeping computer", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return Response.json({ result: { sessions: [], serverEpoch: "idle", revision: 0 } });
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const manager = yield* makeManager;
      yield* manager.close({ threadId: ThreadId.make("thread-a") });
    }).pipe(Effect.provide(stateLayer(config)), Effect.scoped),
  );
  expect(calls).toEqual(["http://computerd/v1/spaces/space-a/browser/peek?threadId=thread-a"]);
});
