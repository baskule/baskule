import * as NodeHttp from "node:http";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaskuleSession } from "../baskule/session";

const state = vi.hoisted(
  (): {
    connection: PreparedConnection | null;
    session: BaskuleSession;
    listeners: Set<() => void>;
    permitted: boolean;
  } => {
    const connection: PreparedConnection | null = null;
    const session: BaskuleSession = { status: "loading" };
    return { connection, session, listeners: new Set<() => void>(), permitted: true };
  },
);
vi.mock("../state/session", () => ({
  readPreparedConnection: () => state.connection,
  readEnvironmentScope: () => state.permitted,
  environmentSession: {
    preparedConnectionValueAtom: () => "prepared",
    sessionStateAtom: () => "session",
  },
}));
vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: {
    subscribe: (_atom: unknown, listener: () => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  },
}));
vi.mock("../baskule/session", () => ({
  readBaskuleSession: () => state.session,
  subscribeBaskuleSession: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
// Exercise HTTP against a real server while substituting only Expo's unavailable native binding.
vi.mock("expo/fetch", () => ({ fetch: globalThis.fetch }));

import {
  bindTransferLifetime,
  captureTransferOrigin,
  fetchNativeFile,
  transferHeaders,
} from "./nativeTransfer";
import {
  createNativePreviewSocket,
  baskulePreviewStreamAccess,
} from "../features/browser/native-preview-socket";

const environmentId = EnvironmentId.make("space-environment");
function connect(serverUrl = "https://front.test", token = "front-token") {
  state.session = {
    status: "signed-in",
    kind: token ? "authenticated" : "anonymous",
    serverUrl,
    token,
    me: {
      authentication: {
        mode: token ? "authenticated" : "anonymous",
        password: !!token,
        providers: [],
      },
      voiceInput: false,
      user: { id: "person", name: "Person", email: "person@example.com", role: "member" },
      organization: { id: "org", name: "Org" },
      spaces: [],
    },
  };
  state.connection = {
    environmentId,
    label: "space",
    httpBaseUrl: `${serverUrl}/s/space`,
    socketUrl: `${serverUrl.replace(/^http/, "ws")}/s/space/ws`,
    httpAuthorization: token ? { _tag: "Bearer", token } : null,
    ...(token ? { socketHeaders: { authorization: `Bearer ${token}` } } : {}),
    target: {
      _tag: "BearerConnectionTarget",
      connectionId: "front-space",
      environmentId,
      label: "space",
    },
  };
  return { environmentId, origin: captureTransferOrigin(environmentId) };
}
beforeEach(() => {
  state.permitted = true;
  state.listeners.clear();
  connect();
});

it.each([
  "https://external.test/s/space/api/asset",
  "https://front.test/s/other/api/asset",
  "https://front.test/s/space-suffix/api/asset",
  "https://front.test/s/space/../other/api/asset",
  "https://front.test/s/space/%2e%2e/other/api/asset",
  "https://front.test/s/space/a%2fb",
  "https://front.test/s/space/%252e%252e/a",
  "https://front.test/s/space/%zz",
  "https://front.test/s/space\\other",
  "https://user:password@front.test/s/space/api/asset",
  "https://front.test/api/baskule/transcriptions",
])("refuses a protected target before any request: %s", async (url) => {
  const transfer = connect();
  await expect(
    fetchNativeFile({ url, transfer, signal: new AbortController().signal }),
  ).rejects.toThrow();
});

it("binds a URL to the original connection and account, including anonymous accounts", () => {
  const transfer = connect();
  expect(transferHeaders({ ...transfer, url: "https://front.test/s/space/api/asset" })).toEqual({
    Authorization: "Bearer front-token",
  });
  connect("https://front.test", "replacement");
  expect(() =>
    transferHeaders({ ...transfer, url: "https://front.test/s/space/api/asset" }),
  ).toThrow("originating connection");
  const anonymous = connect("https://front.test", "");
  expect(transferHeaders({ ...anonymous, url: "https://front.test/s/space/api/asset" })).toEqual(
    {},
  );
});

it("cannot recapture a front connection after sign-out before the connection atom clears", () => {
  connect();
  state.session = { status: "signed-out", serverUrl: "https://front.test" };
  expect(() => captureTransferOrigin(environmentId)).toThrow("not connected");
});

it("invalidates a protected file on read-scope revocation", () => {
  const transfer = connect();
  const invalidate = vi.fn();
  const lifetime = bindTransferLifetime({
    ...transfer,
    scope: "filesystem:read",
    signal: new AbortController().signal,
    invalidate,
  });
  state.permitted = false;
  for (const listener of state.listeners) listener();
  expect(lifetime.signal.aborted).toBe(true);
  expect(invalidate).toHaveBeenCalledOnce();
  lifetime.dispose();
});

it("passes prepared bearer headers in RN's third socket argument and no bearer for anonymous", () => {
  const opened = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class {
      readonly readyState = 1;
      constructor(...args: unknown[]) {
        opened(...args);
      }
    },
  );
  try {
    const url =
      "wss://front.test/s/space/api/preview-stream/ws?threadId=thread&tabId=tab&maxWidth=800&maxHeight=600";
    createNativePreviewSocket({ ...connect(), url });
    expect(opened).toHaveBeenLastCalledWith(url, undefined, {
      headers: { authorization: "Bearer front-token", Cookie: "" },
    });
    if (!state.connection) throw new Error("Missing prepared connection.");
    state.connection = {
      ...state.connection,
      socketHeaders: { authorization: "Bearer front-token", cookie: "ambient=secret" },
    };
    createNativePreviewSocket({ environmentId, origin: captureTransferOrigin(environmentId), url });
    expect(opened).toHaveBeenLastCalledWith(url, undefined, {
      headers: { authorization: "Bearer front-token", Cookie: "" },
    });
    createNativePreviewSocket({ ...connect("https://front.test", ""), url });
    expect(opened).toHaveBeenLastCalledWith(url, undefined, { headers: { Cookie: "" } });
    expect(() =>
      createNativePreviewSocket({ ...connect(), url: url.replace("/s/space/", "/s/other/") }),
    ).toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["front-token", ""])(
  "bypasses T3 tickets for authenticated and anonymous front streams: %s",
  (token) => {
    const { origin } = connect("https://front.test", token);
    expect(baskulePreviewStreamAccess(origin.connection)).toEqual({
      httpBase: "https://front.test/s/space/api/preview-stream",
      wsBase: "wss://front.test/s/space/api/preview-stream",
      query: {},
      credentials: false,
    });
  },
);

it.each(["account", "connection", "disconnect"])(
  "aborts transfers and invalidates cached files on %s replacement",
  (kind) => {
    const transfer = connect();
    const invalidate = vi.fn();
    const lifetime = bindTransferLifetime({
      ...transfer,
      signal: new AbortController().signal,
      invalidate,
    });
    if (kind === "account")
      state.session = { status: "signed-out", serverUrl: "https://front.test" };
    else if (kind === "disconnect") state.connection = null;
    else if (state.connection) state.connection = { ...state.connection };
    for (const listener of state.listeners) listener();
    expect(lifetime.signal.aborted).toBe(true);
    expect(invalidate).toHaveBeenCalled();
    lifetime.dispose();
    expect(state.listeners.size).toBe(0);
  },
);

it("sends bearer-authenticated original bytes and blocks redirects before a second request", async () => {
  const bytes = Uint8Array.from([0, 255, 128, 13, 10, 1, 0, 192]);
  const requests: {
    path: string;
    authorization: string | undefined;
    cookie: string | undefined;
    bytes: Buffer;
  }[] = [];
  await using server = NodeHttp.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      bytes: Buffer.concat(chunks),
    });
    if (request.url?.endsWith("redirect")) {
      response.writeHead(307, { Location: "/s/other/secret" }).end();
      return;
    }
    if (
      request.url?.startsWith("/s/space") &&
      request.headers.authorization !== "Bearer front-token"
    ) {
      response.writeHead(401).end();
      return;
    }
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address.");
  const front = `http://127.0.0.1:${address.port}`;
  const transfer = connect(front);
  const signal = new AbortController().signal;
  const response = await fetchNativeFile({
    url: `${front}/s/space/upload`,
    transfer,
    signal,
    method: "POST",
    body: bytes,
    contentType: "application/octet-stream",
  });
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(requests[0]?.bytes).toEqual(Buffer.from(bytes));
  expect(requests[0]?.authorization).toBe("Bearer front-token");
  expect(requests[0]?.cookie).toBeUndefined();
  const download = await fetchNativeFile({ url: `${front}/s/space/download`, transfer, signal });
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  await expect(
    fetchNativeFile({ url: `${front}/s/space/redirect`, transfer, signal }),
  ).rejects.toThrow();
  expect(requests.map((request) => request.path)).toEqual([
    "/s/space/upload",
    "/s/space/download",
    "/s/space/redirect",
  ]);
  await fetchNativeFile({ url: `${front}/external`, transfer: null, signal });
  expect(requests.at(-1)?.authorization).toBeUndefined();
  const external = await fetchNativeFile({
    url: `${front}/external-redirect`,
    transfer: null,
    signal,
  });
  expect(new Uint8Array(await external.arrayBuffer())).toEqual(bytes);
  expect(requests.slice(-2).map(({ path }) => path)).toEqual([
    "/external-redirect",
    "/s/other/secret",
  ]);
  expect(requests.slice(-2).every(({ authorization, cookie }) => !authorization && !cookie)).toBe(
    true,
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchNativeFile({ url: `${front}/s/space/cancelled`, transfer, signal: controller.signal }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(6);
});

it("cancels an active native response body without keeping partial bytes", async () => {
  const disconnected = Promise.withResolvers<void>();
  await using server = NodeHttp.createServer((_request, response) => {
    response.once("close", () => disconnected.resolve());
    response.writeHead(200);
    response.write(Uint8Array.of(0, 255, 128));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address.");
  const front = `http://127.0.0.1:${address.port}`;
  const transfer = connect(front);
  const controller = new AbortController();
  const response = await fetchNativeFile({
    url: `${front}/s/space/stream`,
    transfer,
    signal: controller.signal,
  });
  const reading = response.arrayBuffer();
  controller.abort();
  await expect(reading).rejects.toThrow();
  await disconnected.promise;
});
