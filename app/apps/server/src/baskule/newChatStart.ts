// baskule: title generation and the first turn share embedded OpenCode in one cell.
// Dispatch records the title request without queueing it; ProviderTurnStartService queues it
// once the run leaves "starting" (running, failed or stopped), using upstream's effect id.
import { Effect } from "effect";
import type { CommandId, MessageId, ThreadId } from "@t3tools/contracts";

import type { PendingOrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";
import { BaskuleRpcPolicy } from "./rpcPolicy.ts";

/** Whether this server runs in an Baskule space (the space sets the RPC policy). */
export const isBaskuleSpace = Effect.map(
  Effect.service(BaskuleRpcPolicy),
  (policy) => policy !== undefined,
);

export const titleEffectAfterStart = (input: {
  readonly requestId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}): PendingOrchestrationEffectV2 => ({
  id: `effect:${input.requestId}:thread-title.generate`,
  commandId: input.requestId,
  threadId: input.threadId,
  request: { type: "thread-title.generate", kind: { type: "initial", messageId: input.messageId } },
});
