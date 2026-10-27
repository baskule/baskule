// @vitest-environment jsdom
import {
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  phase: "connected" as "connected" | "offline",
  assetAtom: {},
  mint: vi.fn(),
  assetQuery: vi.fn(),
  fetch: vi.fn(),
  write: vi.fn(),
  connection: {
    environmentId: "asset-environment",
    httpBaseUrl: "https://host.test/",
    httpAuthorization: null,
  },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("react-native", () => ({}));
vi.mock("expo", () => ({ requireNativeModule: () => ({ evictImage() {} }) }));
vi.mock("expo/fetch", () => ({ fetch: state.fetch }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "00000000-0000-4000-8000-000000000000" }));
vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    exists = true;
    constructor(parent: string | Directory, name?: string) {
      this.uri = [typeof parent === "string" ? parent : parent.uri, name].filter(Boolean).join("/");
    }
    create() {}
    list() {
      return [];
    }
    delete() {
      this.exists = false;
    }
  }
  class File {
    readonly uri: string;
    constructor(parent: Directory, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    create() {}
    writableStream() {
      return new WritableStream<Uint8Array>({
        write: (bytes) => {
          state.write(this.uri, Array.from(bytes));
        },
      });
    }
  }
  return { Directory, File, Paths: { cache: "file:///cache" } };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.assetAtom
      ? AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 })
      : AsyncResult.initial(false),
}));
vi.mock("./session", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    readPreparedConnection: () => state.connection,
    readEnvironmentScope: () => true,
    environmentSession: {
      preparedConnectionValueAtom: Atom.family(() => Atom.make(null)),
      sessionStateAtom: Atom.family(() => Atom.make(null)),
    },
    usePreparedConnection: () => ({ _tag: "Some", value: state.connection }),
  };
});
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: state.phase, error: null } },
  }),
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: () => ({ data: state.session, error: null }),
}));
vi.mock("./projectClones", () => ({ environmentProjectCloneListAtom: () => null }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/assets")>()),
  createAssetEnvironmentAtoms: () => ({ createUrl: state.assetQuery }),
}));
vi.mock("./use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));

import { useRefreshAssetUrl, useAssetUrlState } from "./assets";

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  state.fetch.mockReset().mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
  state.write.mockReset();
  state.session = null;
  state.phase = "connected";
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const cachedUri =
  "file:///cache/t3-attachment-downloads/1700000000000-00000000-0000-4000-8000-000000000000/image.png";

function renderHook<A>(hook: () => A) {
  const values: A[] = [];
  function Probe() {
    values.push(hook());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  return {
    get value() {
      return values.at(-1)!;
    },
    render: () =>
      act(async () => {
        root.render(createElement(Probe));
      }),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it.each(["workspace-file", "media-file"] as const)(
  "keeps %s loading until its file grant resolves",
  async (_tag) => {
    using view = renderHook(() => useAssetUrlState(environmentId, { ...resource, _tag }));
    await view.render();
    expect(view.value).toEqual({ _tag: "Loading" });
    expect(state.assetQuery).not.toHaveBeenCalled();

    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    await view.render();
    expect(view.value).toEqual({
      _tag: "Success",
      expiresAt: 1,
      url: cachedUri,
    });
  },
);

it("hides host assets with a denied grant while preserving attachments", async () => {
  state.session = { authenticated: true, scopes: [] };
  using host = renderHook(() => useAssetUrlState(environmentId, resource));
  await host.render();
  expect(host.value).toEqual({
    _tag: "Failure",
    reason: "missing-file-access",
  });
  expect(state.assetQuery).not.toHaveBeenCalled();
  expect(state.fetch).not.toHaveBeenCalled();
  using attachment = renderHook(() =>
    useAssetUrlState(environmentId, { _tag: "attachment", attachmentId: "upload" }),
  );
  await attachment.render();
  expect(attachment.value).toEqual({
    _tag: "Success",
    expiresAt: 1,
    url: cachedUri.replace(/image\.png$/, "asset"),
  });
});

it("stops waiting for an unresolved grant when the connection is offline", async () => {
  state.phase = "offline";
  using view = renderHook(() => useAssetUrlState(environmentId, resource));
  await view.render();
  expect(view.value).toEqual({
    _tag: "Failure",
    reason: "disconnected",
  });
  expect(state.assetQuery).not.toHaveBeenCalled();
});

it("lets the server authorize an explicit refresh before the client grant loads", async () => {
  using view = renderHook(() => useRefreshAssetUrl(environmentId, resource));
  await view.render();
  await expect(view.value()).resolves.toBe(cachedUri);
  expect(state.fetch).toHaveBeenCalledWith(
    "https://host.test/api/assets/image.png",
    expect.objectContaining({ credentials: "omit" }),
  );
  expect(state.write).toHaveBeenCalledWith(cachedUri, [1, 2, 3]);
  expect(state.mint).toHaveBeenCalledWith({ environmentId, input: { resource } });

  const denied = new EnvironmentAuthorizationError({
    message: "This connection cannot read host files.",
    requiredScope: AuthFilesystemReadScope,
  });
  state.mint.mockResolvedValue(AsyncResult.failure(Cause.fail(denied)));
  await expect(view.value()).resolves.toBeNull();
});
