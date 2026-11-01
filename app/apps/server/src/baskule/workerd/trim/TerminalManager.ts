import * as Stream from "effect/Stream";
// baskule: workerd replacement for `terminal/Manager.ts` (see build.mjs). A space cell runs no processes, so it
// has no terminals: the `terminal.*` RPCs are off (rpcPolicy.ts) and the agent's shell runs on the space computer.
// The services that still hold a TerminalManager (setup scripts, thread settlement and cleanup, storage cleanup)
// see a manager with no sessions: closing is a no-op, subscriptions never fire, opening fails.
// The service key is the real module's, on purpose (stubs keep the replaced module's identity).
// @effect-diagnostics deterministicKeys:off
import {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderEnvironmentError,
  TerminalProviderInstanceNotFoundError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as Real from "../../../terminal/Manager.ts";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
};

type Service = Real.TerminalManager["Service"];

const notRunning = (input: {
  readonly threadId: string;
  readonly terminalId?: string | undefined;
}) =>
  Effect.fail(
    new TerminalNotRunningError({ threadId: input.threadId, terminalId: input.terminalId ?? "" }),
  );
const noop = () => {};

const inert: Service = {
  open: notRunning,
  attachStream: notRunning,
  attachOutputStream: (input) => Stream.unwrap(notRunning(input)),
  observeStream: notRunning,
  resyncStream: notRunning,
  write: notRunning,
  resize: notRunning,
  clear: notRunning,
  close: () => Effect.void,
  closeIdle: () => Effect.void,
  subscribe: () => Effect.succeed(noop),
  subscribeMetadata: () => Effect.succeed(noop),
};

export class TerminalManager extends Context.Service<TerminalManager, Service>()(
  "t3/terminal/Manager/TerminalManager",
) {}

export const layer = Layer.succeed(TerminalManager, inert);
