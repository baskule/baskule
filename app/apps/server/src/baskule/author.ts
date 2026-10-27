// baskule: authorship in shared spaces (E8). The server stamps who sent a command from the
// Baskule identity of the socket, at the RPC boundary; a client-supplied author is dropped.
// Field shape: `OrchestrationV2Author {id, name}` on the creation fields (shared with the web).
import type {
  OrchestrationV2Author,
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import type { HttpServerRequest } from "effect/http";

import { BASKULE_IDENTITY_HEADER, parseBaskuleIdentity } from "./identity.ts";

export const baskuleAuthorFromRequest = (
  request: HttpServerRequest.HttpServerRequest,
): OrchestrationV2Author | undefined => {
  const identity = parseBaskuleIdentity(request.headers[BASKULE_IDENTITY_HEADER]);
  return identity ? { id: identity.userId, name: identity.name || identity.email } : undefined;
};

/**
 * Every client command carrying creation fields (message.dispatch, thread.create, …) gets the
 * socket's author, and only it.
 */
export const stampCommandAuthor = <C extends OrchestrationV2Command>(
  command: C,
  author: OrchestrationV2Author | undefined,
): C => {
  if (!("createdBy" in command) && !("author" in command)) return command;
  const { author: _clientAuthor, ...rest } = command as C & { author?: unknown };
  return (author === undefined ? rest : { ...rest, author }) as C;
};

export const stampLaunchAuthor = (
  initialMessage: OrchestrationV2ThreadLaunchInput["initialMessage"],
  author: OrchestrationV2Author | undefined,
) => (initialMessage === undefined || author === undefined ? {} : { author });
