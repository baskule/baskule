import { expect, it, vi } from "vite-plus/test";
import { baskuleManagementDestination } from "@t3tools/contracts/baskule";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  open: vi.fn<() => Promise<void>>(),
  refresh: vi.fn(),
  current: {
    status: "signed-in",
    serverUrl: "https://baskule.example.com",
    token: "native-secret",
  },
}));
vi.mock("expo/fetch", () => ({ fetch: mocks.fetch }));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: mocks.open }));
vi.mock("./session", () => ({
  readBaskuleSession: () => mocks.current,
  refreshBaskuleMe: mocks.refresh,
}));
import { openBaskuleManagement } from "./management";

function setup(token = "native-secret") {
  mocks.current = { status: "signed-in", serverUrl: "https://baskule.example.com", token };
  mocks.fetch
    .mockReset()
    .mockResolvedValue(Response.json({ code: "one-time-code", expiresAt: Date.now() + 60_000 }));
  mocks.open.mockReset().mockResolvedValue();
  mocks.refresh.mockReset();
}

it("hands off a one-time code in the fragment without exposing the bearer", async () => {
  setup();
  await openBaskuleManagement("/settings/plugins");
  const [url, init] = mocks.fetch.mock.calls[0]!;
  expect(url).toBe("https://baskule.example.com/auth/connect/code");
  expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer native-secret");
  expect(mocks.open).toHaveBeenCalledWith(
    "https://baskule.example.com/link#code=one-time-code&destination=%2Fsettings%2Fplugins",
  );
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("opens anonymous management without creating a session", async () => {
  setup("");
  await openBaskuleManagement("/settings/spaces");
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.open).toHaveBeenCalledWith("https://baskule.example.com/settings/spaces");
});

it("does not open a late link after account replacement", async () => {
  setup();
  mocks.fetch.mockImplementation(async () => {
    mocks.current = { ...mocks.current, token: "different-account" };
    return Response.json({ code: "old-account", expiresAt: Date.now() + 60_000 });
  });
  await expect(openBaskuleManagement("/admin")).rejects.toThrow(/account changed/);
  expect(mocks.open).not.toHaveBeenCalled();
});

it("does not open expired handoffs", async () => {
  setup();
  mocks.fetch.mockResolvedValue(Response.json({ code: "expired", expiresAt: Date.now() - 1 }));
  await expect(openBaskuleManagement("/settings/account")).rejects.toThrow(/expired/);
  expect(mocks.open).not.toHaveBeenCalled();
});

it.each([
  "https://evil.example",
  "//evil.example",
  "/s/team/ws",
  "/auth/sign-out",
  "/settings/plugins?redirect=elsewhere",
  "/settings/plugins#token=secret",
])("rejects unapproved browser destinations (%s)", (path) => {
  expect(baskuleManagementDestination(path)).toBeNull();
});
