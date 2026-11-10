// @effect-diagnostics globalFetch:off -- Local CLI HTTP transport uses the platform fetch implementation.
import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

class McpToolSessionError extends Schema.TaggedError<McpToolSessionError>()("McpToolSessionError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const bridgeError = (cause: unknown): McpToolSessionError =>
  Schema.is(McpToolSessionError)(cause)
    ? cause
    : new McpToolSessionError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

interface McpToolSessionOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly clientName: string;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface McpToolSession {
  /** Resolves to the JSON-RPC `result` of `tools/call`, a `CallToolResult`. */
  readonly call: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, McpToolSessionError>;
}

/**
 * One initialized MCP session over T3 Code's HTTP endpoint, terminated when
 * the scope closes. Used by `t3 thread`.
 */
export const mcpToolSession = (
  options: McpToolSessionOptions,
): Effect.Effect<McpToolSession, McpToolSessionError, Scope.Scope> => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 0;

  const headers = () => ({
    accept: "application/json, text/event-stream",
    authorization: options.authorization,
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
  });

  const send = Effect.fn("cli.thread.mcp.send")(function* (
    message: unknown,
  ): Effect.fn.Return<ReadonlyArray<unknown>, McpToolSessionError> {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(message).pipe(
      Effect.mapError(bridgeError),
    );
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchImplementation(options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers() },
          body,
          signal,
        }),
      catch: bridgeError,
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      yield* discardResponseBody(response);
      return yield* new McpToolSessionError({
        message: `T3 Code MCP endpoint responded with HTTP ${response.status}.`,
      });
    }
    const payloads = yield* Stream.runCollect(responsePayloads(response, bridgeError));
    for (const payload of payloads) {
      protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
    }
    return payloads;
  });

  const request = Effect.fn("cli.thread.mcp.request")(function* (
    method: string,
    params: unknown,
  ): Effect.fn.Return<JsonRpcEnvelope, McpToolSessionError> {
    const id = `t3-cli-${nextId++}`;
    const responses = yield* send({ jsonrpc: "2.0", id, method, params });
    const envelope = asEnvelope(responses.find((entry) => asEnvelope(entry)?.id === id));
    if (envelope === null || envelope.error !== undefined) {
      const detail =
        envelope?.error === undefined
          ? "."
          : `: ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(envelope.error).pipe(Effect.mapError(bridgeError))}`;
      return yield* new McpToolSessionError({ message: `T3 Code MCP ${method} failed${detail}` });
    }
    return envelope;
  });

  const terminate = Effect.suspend(() =>
    sessionId === null
      ? Effect.void
      : Effect.tryPromise({
          try: () =>
            fetchImplementation(options.endpoint, { method: "DELETE", headers: headers() }),
          catch: bridgeError,
        }).pipe(Effect.flatMap(discardResponseBody), Effect.ignore),
  );

  // Registered before the handshake so a session the server opened is ended
  // even when the handshake fails, and the handshake stays interruptible.
  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() => terminate);
    yield* request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: options.clientName, version: "0.0.0" },
    });
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return {
      call: (tool, args) =>
        request("tools/call", { name: tool, arguments: args }).pipe(
          Effect.map((envelope) => envelope.result),
        ),
    } satisfies McpToolSession;
  });
};
