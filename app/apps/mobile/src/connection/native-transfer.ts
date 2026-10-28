import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { AuthEnvironmentScope, EnvironmentId } from "@t3tools/contracts";

import { readBaskuleSession, subscribeBaskuleSession } from "../baskule/session";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession, readEnvironmentScope, readPreparedConnection } from "../state/session";

export interface TransferOrigin {
  readonly connection: PreparedConnection;
  readonly serverUrl: string | null;
  readonly token: string | null;
}

export interface ProtectedTransfer {
  readonly environmentId: EnvironmentId;
  readonly origin: TransferOrigin;
  readonly scope?: AuthEnvironmentScope;
}

export function readTransferOrigin(environmentId: EnvironmentId): TransferOrigin | null {
  const connection = readPreparedConnection(environmentId);
  if (!connection) return null;
  const session = readBaskuleSession();
  if (
    (connection.socketHeaders || new URL(connection.httpBaseUrl).pathname.startsWith("/s/")) &&
    session.status !== "signed-in"
  )
    return null;
  return {
    connection,
    serverUrl: session.status === "signed-in" ? session.serverUrl : null,
    token: session.status === "signed-in" ? session.token : null,
  };
}

export function captureTransferOrigin(environmentId: EnvironmentId): TransferOrigin {
  const origin = readTransferOrigin(environmentId);
  if (!origin) throw new Error("The environment is not connected.");
  return origin;
}

export function isTransferOriginCurrent(origin: TransferOrigin): boolean {
  const current = readTransferOrigin(origin.connection.environmentId);
  return (
    current !== null &&
    current.connection === origin.connection &&
    current.serverUrl === origin.serverUrl &&
    current.token === origin.token
  );
}

/** Validate the raw path as well as URL.pathname: URL parsing erases dot segments. */
function transferUrl(value: string): URL {
  if (/[\\\s]/.test(value) || Array.from(value).some((character) => character.charCodeAt(0) < 32))
    throw new Error("Invalid file URL.");
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("Invalid file URL.");
  }
  const path = value.match(/^https?:\/\/[^/]+([^?#]*)/i)?.[1] ?? "";
  if (path.includes("//")) throw new Error("Invalid file path.");
  for (const segment of path.split("/")) {
    const decoded = decodeURIComponent(segment);
    if (
      decoded === "." ||
      decoded === ".." ||
      /[/\\%]/.test(decoded) ||
      Array.from(decoded).some((character) => character.charCodeAt(0) < 32)
    ) {
      throw new Error("Invalid file path.");
    }
  }
  return url;
}

export function transferHeaders(
  input: ProtectedTransfer & { readonly url: string },
): Readonly<Record<string, string>> {
  const { connection } = input.origin;
  if (connection.environmentId !== input.environmentId || !isTransferOriginCurrent(input.origin)) {
    throw new Error("The originating connection is no longer active.");
  }
  const base = transferUrl(connection.httpBaseUrl);
  const target = transferUrl(input.url);
  const prefix = base.pathname.replace(/\/$/, "") + "/";
  if (base.origin !== target.origin || !target.pathname.startsWith(prefix)) {
    throw new Error("The file URL is outside the originating environment.");
  }
  if (input.origin.serverUrl !== null) {
    const server = transferUrl(input.origin.serverUrl);
    if (server.origin !== base.origin || !/^\/s\/[^/]+\/$/.test(prefix)) {
      throw new Error("Invalid Baskule space URL.");
    }
  }
  const authorization = connection.httpAuthorization;
  if (authorization?._tag === "Dpop") throw new Error("This file connection requires DPoP.");
  if (authorization?._tag === "Bearer") {
    if (input.origin.token !== null && authorization.token !== input.origin.token) {
      throw new Error("The originating account is no longer active.");
    }
    return { Authorization: `Bearer ${authorization.token}` };
  }
  return {};
}

/** Owns cancellation for a transfer and, for cached files, their account lifetime. */
export function bindTransferLifetime(
  input: ProtectedTransfer & {
    readonly signal: AbortSignal;
    readonly invalidate?: () => void;
    readonly scope?: AuthEnvironmentScope;
  },
) {
  const controller = new AbortController();
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    input.invalidate?.();
  };
  const check = () => {
    if (
      !isTransferOriginCurrent(input.origin) ||
      (input.scope && !readEnvironmentScope(input.environmentId, input.scope))
    )
      abort();
  };
  const unsubscribeSession = subscribeBaskuleSession(check);
  const unsubscribeConnection = appAtomRegistry.subscribe(
    environmentSession.preparedConnectionValueAtom(input.environmentId),
    check,
  );
  const unsubscribeScope = input.scope
    ? appAtomRegistry.subscribe(environmentSession.sessionStateAtom(input.environmentId), check)
    : null;
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  check();
  return {
    signal: controller.signal,
    dispose: () => {
      input.signal.removeEventListener("abort", abort);
      unsubscribeSession();
      unsubscribeConnection();
      unsubscribeScope?.();
    },
  };
}

export async function fetchNativeFile(input: {
  readonly url: string;
  readonly transfer: ProtectedTransfer | null;
  readonly signal: AbortSignal;
  readonly method?: "POST";
  readonly body?: BodyInit;
  readonly contentType?: string;
}) {
  const { fetch } = await import("expo/fetch");
  const url = transferUrl(input.url);
  const headers = input.transfer ? transferHeaders({ ...input.transfer, url: input.url }) : {};
  return fetch(url.href, {
    method: input.method ?? "GET",
    body: input.body,
    headers: { ...headers, ...(input.contentType ? { "Content-Type": input.contentType } : {}) },
    credentials: "omit",
    redirect: input.transfer ? "error" : "follow",
    signal: input.signal,
  });
}
