// @effect-diagnostics globalFetch:off preferSchemaOverJson:off abortControllerInEffect:off - This boundary uses workerd native fetch and a JSON bridge.
// Fetch-only edge of the computer-side browser. Merely subscribing or listing never wakes a computer.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  PreviewSessionLookupError,
  PreviewClearProfileError,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  type PreviewEvent,
  type PreviewListResult,
} from "@t3tools/contracts";
import type { PreviewManager } from "../../preview/Manager.ts";
import type { ServerBrowser } from "../../preview/ServerBrowser.ts";
import * as Broker from "../../mcp/PreviewAutomationBroker.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";

export interface BridgeConfig {
  readonly url: string;
  readonly token: string;
  readonly spaceId: string;
}
export const endpoint = (config: BridgeConfig, path: string) =>
  `${config.url.replace(/\/$/, "")}/v1/spaces/${encodeURIComponent(config.spaceId)}/browser/${path}`;
export const call = async (config: BridgeConfig, method: string, input: unknown) => {
  const response = await fetch(endpoint(config, "call"), {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, input }),
  });
  const body = (await response.json()) as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Browser bridge answered ${response.status}`);
  return body.result;
};

// One instance per DO runtime, shared by Manager and ServerBrowser through a layer.
export class RemoteState extends Context.Service<
  RemoteState,
  {
    readonly call: (method: string, input: unknown) => Promise<unknown>;
    readonly events: PubSub.PubSub<PreviewEvent>;
    readonly active: () => boolean;
    readonly inspect: (input: { readonly threadId: string }) => Promise<PreviewListResult>;
  }
>()("t3/baskule/browser/remote/RemoteState") {}
export const stateLayer = (config: BridgeConfig) =>
  Layer.effect(
    RemoteState,
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<PreviewEvent>();
      const run = Effect.runForkWith(yield* Effect.context<never>());
      const controller = new AbortController();
      let active = false;
      let profiles: unknown = null;
      let pumping = false;
      let connected: Promise<void> = Promise.resolve();
      const pump = () => {
        if (pumping) return connected;
        pumping = true;
        connected = new Promise<void>((resolve, reject) => {
          void (async () => {
            try {
              const response = await fetch(endpoint(config, "events"), {
                headers: { authorization: `Bearer ${config.token}` },
                signal: controller.signal,
              });
              if (!response.ok || !response.body)
                throw new Error(`Browser events ${response.status}`);
              const reader = response.body.getReader();
              resolve();
              const decoder = new TextDecoder();
              let buffer = "";
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let end;
                while ((end = buffer.indexOf("\n")) !== -1) {
                  const line = buffer.slice(0, end);
                  buffer = buffer.slice(end + 1);
                  if (line) run(PubSub.publish(events, JSON.parse(line)));
                }
              }
            } catch (error) {
              reject(error);
            } finally {
              // A stopped computer is retried only on the next explicit browser action.
              active = false;
              pumping = false;
            }
          })();
        });
        return connected;
      };
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      const inspect = async (input: { readonly threadId: string }): Promise<PreviewListResult> => {
        try {
          const response = await fetch(
            endpoint(config, "peek") + "?threadId=" + encodeURIComponent(input.threadId),
            {
              headers: { authorization: `Bearer ${config.token}` },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (response.ok) {
            const { result } = (await response.json()) as { result: PreviewListResult };
            if (result.sessions.length && !active) {
              active = true;
              void pump().catch(() => {});
            }
            return result;
          }
        } catch {
          /* Asleep or unreachable: metadata reads never start a computer. */
        }
        return { sessions: [], serverEpoch: "baskule-idle", revision: 0 };
      };
      return {
        inspect,
        events,
        active: () => active,
        call: async (method: string, input: unknown) => {
          if (method === "reportProfiles") {
            profiles = input;
            if (!active) return null;
          }
          if (!active) {
            // Only an explicit action may boot the bridge. Metadata connects afterwards,
            // before the action publishes its first tab event.
            await call(
              config,
              "reportProfiles",
              profiles ?? { profiles: [], defaultProfileId: "default" },
            );
            active = true;
          }
          await pump();
          return call(config, method, input);
        },
      };
    }),
  );

export const makeManager = Effect.gen(function* () {
  const state = yield* RemoteState;
  const run = <
    A extends { readonly threadId?: string | undefined; readonly tabId?: string | undefined },
  >(
    method: string,
    input: A,
  ) =>
    Effect.tryPromise({
      try: () => state.call(method, input),
      catch: () =>
        new PreviewSessionLookupError({ threadId: input.threadId ?? "", tabId: input.tabId ?? "" }),
    });
  return {
    open: (input) => run("open", { ...input, beforePublish: undefined, runtime: "server" }),
    navigate: (input) => run("navigate", input),
    resize: (input) => run("resize", input),
    adjust: (input) => run("adjust", input),
    refresh: (input) => run("refresh", input),
    // Closing the tabs of a browser that is not running has nothing to do: deleting a chat (ResourceCleanupService)
    // must never create or start the space's computer. A running browser holding this chat's tabs is found by
    // `inspect`, which never wakes it.
    close: (input) =>
      Effect.promise(
        async () =>
          state.active() || (await state.inspect({ threadId: input.threadId })).sessions.length > 0,
      ).pipe(Effect.flatMap((live) => (live ? run("close", input) : Effect.void))),
    reportStatus: (input) => run("reportStatus", input),
    requestReveal: (input) => run("requestReveal", input),
    list: (input) => Effect.promise(() => state.inspect(input)),
    events: Stream.fromPubSub(state.events),
    subscribeEvents: PubSub.subscribe(state.events),
  } as PreviewManager["Service"];
});

export const makeBrowser = Effect.gen(function* () {
  const state = yield* RemoteState;
  const broker = yield* Broker.PreviewAutomationBroker;
  const environment = yield* Environment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  yield* broker
    .connect(
      {
        clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
        environmentId,
        supportedOperations: [...PREVIEW_AUTOMATION_SERVER_OPERATIONS],
      },
      { preferred: true },
    )
    .pipe(
      Effect.flatMap((events) =>
        Stream.runForEach(events, (event) => {
          if (event.type === "connected") return Effect.void;
          const request = event.request;
          return Effect.tryPromise({
            try: async () => {
              if (request.operation === "status" && !state.active()) {
                await state.inspect({ threadId: request.threadId });
                if (!state.active())
                  return {
                    available: false,
                    visible: false,
                    tabId: null,
                    url: null,
                    title: null,
                    loading: false,
                    tabs: [],
                    profiles: [
                      { id: "default", name: "Default" },
                      { id: "incognito", name: "Incognito", incognito: true },
                    ],
                    defaultProfileId: "default",
                  };
              }
              return state.call("automation", request);
            },
            catch: (error) => String(error),
          }).pipe(
            Effect.match({
              onSuccess: (result) => ({ ok: true as const, result }),
              onFailure: (message) => ({
                ok: false as const,
                error: { _tag: "PreviewAutomationExecutionError" as const, message },
              }),
            }),
            Effect.flatMap((outcome) =>
              broker.respond({
                clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
                connectionId: event.connectionId,
                requestId: request.requestId,
                ...outcome,
              }),
            ),
            Effect.ignore,
            Effect.forkScoped,
            Effect.asVoid,
          );
        }),
      ),
      Effect.exit,
      Effect.andThen(Effect.sleep("1 second")),
      Effect.forever,
      Effect.forkScoped,
    );
  return {
    attachViewer: () => Effect.die("Viewer transport is forwarded directly to the computer"),
    answerFileChooser: () => Effect.succeed(false),
    openDownload: () => Effect.succeedNone,
    clearProfile: (profileId) =>
      Effect.tryPromise({
        try: () => state.call("clearProfile", { profileId }).then(() => {}),
        catch: (cause) => new PreviewClearProfileError({ profileId, cause }),
      }),
    reportProfiles: (input) =>
      Effect.promise(() => state.call("reportProfiles", input)).pipe(Effect.asVoid),
  } satisfies ServerBrowser["Service"];
});
