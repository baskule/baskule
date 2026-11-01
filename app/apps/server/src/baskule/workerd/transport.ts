// @effect-diagnostics anyUnknownInErrorContext:off unsafeEffectTypeAssertion:off globalTimers:off -- native workerd adapter implementing the platform boundary.
// baskule: HTTP and WebSocket transport for T3 inside a Durable Object.
//
// T3 serves an Effect HTTP app through the `HttpServer` service. In a DO nothing listens: this
// `HttpServer` captures the app when T3 calls `serve`, and the cell's `fetch` hands requests to
// it. A WebSocket upgrade gets a `WebSocketPair`; T3's `/ws` route calls `request.upgrade`,
// which accepts the server end, answers 101 with the client end and runs Effect RPC on it.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpEffect, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as NetAddress from "effect/net/NetAddress";
import * as Socket from "effect/socket/Socket";

/** The server end of a `WebSocketPair` as workerd exposes it. */
type WorkerdWebSocket = Socket.WebSocketLike & { accept(): void };

declare const WebSocketPair: { new (): { 0: WorkerdWebSocket; 1: WorkerdWebSocket } };

export interface CapturedApp {
  readonly app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >;
  readonly context: Context.Context<never>;
  readonly handler: (request: Request) => Promise<Response>;
}

export interface Transport {
  readonly layer: Layer.Layer<HttpServer.HttpServer>;
  /** Resolves once T3 has called `serve`. */
  readonly ready: Promise<CapturedApp>;
}

export interface SocketHooks {
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** Called in the event that accepted the socket; the returned function runs on close. */
  readonly onOpen: (close: (code: number, reason: string) => void) => () => void;
}

const failure = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });

export const makeTransport = (): Transport => {
  let resolveReady!: (app: CapturedApp) => void;
  const ready = new Promise<CapturedApp>((resolve) => (resolveReady = resolve));
  const server = HttpServer.make({
    serve: (app, middleware?: HttpMiddleware.HttpMiddleware) =>
      Effect.contextWith((context: Context.Context<never>) => {
        const withMiddleware = (middleware ? middleware(app as never) : app) as CapturedApp["app"];
        resolveReady({
          app: withMiddleware,
          context,
          handler: HttpEffect.toWebHandlerWith(context)(
            app as Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>,
            middleware,
          ),
        });
        return Effect.void;
      }),
    address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 443),
  });
  return { layer: Layer.succeed(HttpServer.HttpServer, server), ready };
};

/** Runs T3's app for one upgrade request on a fresh `WebSocketPair`. */
export const handleUpgrade = (
  captured: CapturedApp,
  request: Request,
  hooks: SocketHooks,
): Promise<Response> => {
  const pair = new WebSocketPair();
  const client = pair[0];
  const socket = pair[1];
  return new Promise<Response>((resolve) => {
    let upgraded = false;
    const serverRequest = HttpServerRequest.fromWeb(request);
    Object.defineProperty(serverRequest, "upgrade", {
      value: Effect.suspend(() => {
        upgraded = true;
        socket.accept();
        const release = hooks.onOpen((code, reason) => {
          try {
            (socket as unknown as { close(code: number, reason: string): void }).close(
              code,
              reason,
            );
          } catch {
            // Already closed.
          }
        });
        let released = false;
        const done = () => {
          if (released) return;
          released = true;
          release();
        };
        socket.addEventListener("close", done);
        socket.addEventListener("error", done);
        resolve(new Response(null, { status: 101, webSocket: client } as ResponseInit));
        return Socket.fromWebSocket(Effect.succeed(socket));
      }),
    });
    const context = Context.add(
      captured.context,
      HttpServerRequest.HttpServerRequest,
      serverRequest,
    );
    const run = captured.app.pipe(
      Effect.map((response) => {
        if (!upgraded) resolve(HttpServerResponse.toWeb(response));
      }),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (!upgraded)
            resolve(failure(500, `WebSocket handler failed: ${String(cause).slice(0, 300)}`));
        }),
      ),
      Effect.scoped,
    );
    hooks.waitUntil(Effect.runPromiseWith(context)(run as Effect.Effect<void>));
  });
};

/**
 * `celld #258` bypass: an interval started in the event that creates long-lived
 * continuations keeps that event's driver alive, so their I/O settles. Returns the canceller.
 */
export const keepAlive = (intervalMs = 5_000): (() => void) => {
  const timer = setInterval(() => {}, intervalMs);
  return () => clearInterval(timer);
};
