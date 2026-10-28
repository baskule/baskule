// baskule: workerd replacement for `preview/ServerBrowser.ts` (see build.mjs). The shared browser runs on the space
// computer (baskule/browser/bridge.ts, built from the real module); in a cell, ServerBrowser is always the
// fetch-only adapter `baskule/browser/remote.ts` (`makeBrowser`), which the real module already selects whenever
// `RemoteState` is provided. Without a computer (no computerd configured), there is no browser to launch.
// The real module's local Playwright implementation (~110 KiB with its page and context helpers) is dropped.
// The service key is the real module's, on purpose (stubs keep the replaced module's identity).
// @effect-diagnostics deterministicKeys:off
import { PreviewClearProfileError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Real from "../../../preview/ServerBrowser.ts";
import { RemoteState, makeBrowser } from "../../browser/remote.ts";

export type {
  ServerBrowserViewer,
  ServerBrowserViewerOutput,
} from "../../../preview/ServerBrowser.ts";

export class ServerBrowserTabNotFoundError extends Schema.TaggedError<ServerBrowserTabNotFoundError>()(
  "ServerBrowserTabNotFoundError",
  { threadId: Schema.String, tabId: Schema.String },
) {
  override get message(): string {
    return "The server preview tab does not exist.";
  }
}

export class ServerBrowserLaunchError extends Schema.TaggedError<ServerBrowserLaunchError>()(
  "ServerBrowserLaunchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The server preview browser could not start.";
  }
}

type Service = Real.ServerBrowser["Service"];

const noComputer: Service = {
  attachViewer: () =>
    Effect.fail(
      new ServerBrowserLaunchError({ cause: "This space has no computer for a shared browser." }),
    ) as unknown as ReturnType<Service["attachViewer"]>,
  answerFileChooser: () => Effect.succeed(false),
  openDownload: () => Effect.succeedNone,
  clearProfile: (profileId) =>
    Effect.fail(new PreviewClearProfileError({ profileId, cause: "no computer" })),
  reportProfiles: () => Effect.void,
};

export class ServerBrowser extends Context.Service<ServerBrowser, Service>()(
  "t3/preview/ServerBrowser",
) {}

export const layer = Layer.effect(
  ServerBrowser,
  Effect.gen(function* () {
    const remote = yield* Effect.serviceOption(RemoteState);
    if (Option.isNone(remote)) return noComputer;
    return yield* makeBrowser.pipe(Effect.provideService(RemoteState, remote.value));
  }),
);
