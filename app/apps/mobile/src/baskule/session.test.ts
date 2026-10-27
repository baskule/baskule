import { describe, expect, it, vi } from "vite-plus/test";

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  token: null as string | null,
  failWrite: false,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (storage.failWrite) {
        storage.failWrite = false;
        throw new Error("disk full");
      }
      storage.values.set(key, value);
    },
  },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => storage.token,
  setItemAsync: async (_key: string, token: string) => {
    storage.token = token;
  },
  deleteItemAsync: async () => {
    storage.token = null;
  },
}));
vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock("../i18n", () => ({ t: (text: string) => text }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  fetchMe: vi.fn(),
  fetchInstance: vi.fn(),
  signOut: vi.fn(),
}));

const me = {
  authentication: { mode: "anonymous", password: false, providers: [] },
  voiceInput: false,
  user: { id: "a", name: "A", email: "a@example.com", role: "member" },
  organization: { id: "org", name: "Org" },
  spaces: [{ id: "personal-a", name: "Personal", kind: "personal", role: "owner", base: "/s/a" }],
} satisfies import("./api").BaskuleMe;

async function setup() {
  vi.resetModules();
  storage.values.clear();
  storage.token = null;
  storage.failWrite = false;
  const api = await import("./api");
  vi.mocked(api.fetchMe).mockReset();
  const session = await import("./session");
  return { api, session };
}
async function restore(session: typeof import("./session")) {
  const timer = vi
    .spyOn(globalThis, "setInterval")
    .mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
  try {
    await session.loadBaskuleSession();
  } finally {
    timer.mockRestore();
  }
}

describe("device connection", () => {
  it("restores an anonymous identity offline, then keeps disconnect across restart", async () => {
    const { api, session } = await setup();
    storage.values.set(
      "baskule.connection",
      JSON.stringify({ kind: "anonymous", serverUrl: "https://a.example", me }),
    );
    vi.mocked(api.fetchMe).mockRejectedValue(new Error("offline"));
    await restore(session);
    expect(session.readBaskuleSession()).toMatchObject({
      status: "signed-in",
      kind: "anonymous",
      token: "",
      me,
    });
    expect(api.fetchInstance).not.toHaveBeenCalled();
    await session.signOutOfBaskule();
    vi.resetModules();
    const restarted = await import("./session");
    await restore(restarted);
    expect(restarted.readBaskuleSession()).toEqual({
      status: "signed-out",
      serverUrl: "https://a.example",
    });
  });

  it("keeps the original connection when replacement fails or is cancelled", async () => {
    const { api, session } = await setup();
    vi.mocked(api.fetchMe).mockResolvedValueOnce(me);
    await session.completeBaskuleSignIn("https://a.example", "token-a");
    vi.mocked(api.fetchMe).mockRejectedValueOnce(new Error("offline"));
    await expect(session.completeBaskuleSignIn("https://b.example", "token-b")).rejects.toThrow(
      "offline",
    );
    let finish!: (value: typeof me) => void;
    vi.mocked(api.fetchMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = session.completeBaskuleSignIn("https://b.example", "token-b");
    session.cancelBaskuleSignIn();
    finish(me);
    await pending;
    expect(session.readBaskuleSession()).toMatchObject({
      serverUrl: "https://a.example",
      token: "token-a",
    });
    expect(storage.token).toBe("token-a");
    expect(JSON.parse(storage.values.get("baskule.connection")!)).toMatchObject({
      serverUrl: "https://a.example",
    });
  });

  it("rejects a late anonymous refresh from another server after switching", async () => {
    const { api, session } = await setup();
    vi.mocked(api.fetchMe).mockResolvedValueOnce(me);
    await session.completeBaskuleSignIn("https://a.example", "");
    let finish!: (value: typeof me) => void;
    vi.mocked(api.fetchMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = session.refreshBaskuleMe();
    const other = { ...me, user: { ...me.user, id: "b" } };
    vi.mocked(api.fetchMe).mockResolvedValueOnce(other);
    await session.completeBaskuleSignIn("https://b.example", "");
    finish(me);
    await refresh;
    expect(session.readBaskuleSession()).toMatchObject({
      serverUrl: "https://b.example",
      me: other,
    });
    expect(JSON.parse(storage.values.get("baskule.connection")!)).toMatchObject({
      serverUrl: "https://b.example",
      me: other,
    });
  });

  it("rejects a late sign-in after disconnect", async () => {
    const { api, session } = await setup();
    vi.mocked(api.fetchMe).mockResolvedValueOnce(me);
    await session.completeBaskuleSignIn("https://a.example", "");
    let finish!: (value: typeof me) => void;
    vi.mocked(api.fetchMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = session.completeBaskuleSignIn("https://b.example", "token-b");
    await session.signOutOfBaskule();
    finish(me);
    await pending;
    expect(session.readBaskuleSession().status).toBe("signed-out");
    expect(storage.token).toBeNull();
  });
  it("restores the original credential when replacement persistence fails", async () => {
    const { api, session } = await setup();
    vi.mocked(api.fetchMe).mockResolvedValue(me);
    await session.completeBaskuleSignIn("https://a.example", "token-a");
    storage.failWrite = true;
    await expect(session.completeBaskuleSignIn("https://b.example", "token-b")).rejects.toThrow(
      "disk full",
    );
    expect(storage.token).toBe("token-a");
    vi.resetModules();
    const restarted = await import("./session");
    vi.mocked((await import("./api")).fetchMe).mockRejectedValue(new Error("offline"));
    await restore(restarted);
    expect(restarted.readBaskuleSession()).toMatchObject({
      serverUrl: "https://a.example",
      token: "token-a",
    });
  });

  it("keeps the newer sign-in when an older sign-in finishes last", async () => {
    const { api, session } = await setup();
    let finish!: (value: typeof me) => void;
    vi.mocked(api.fetchMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const older = session.completeBaskuleSignIn("https://a.example", "token-a");
    vi.mocked(api.fetchMe).mockResolvedValueOnce(me);
    await session.completeBaskuleSignIn("https://b.example", "token-b");
    finish(me);
    await older;
    expect(session.readBaskuleSession()).toMatchObject({
      serverUrl: "https://b.example",
      token: "token-b",
    });
    expect(storage.token).toBe("token-b");
  });
});
