import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const transport = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock("expo/fetch", () => transport);
import { deletePushDevice, fetchPushAvailability, putPushDevice } from "./push-api";
const session = { serverUrl: "https://front.test", token: "private-bearer", userId: "alice" };
const registration = {
  platform: "android" as const,
  appId: "test.app",
  token: "native",
  preferences: {
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};
beforeEach(() => transport.fetch.mockReset());
describe("native front push API", () => {
  it("uses expo/fetch, rejects redirects, omits cookies, and sends only the current bearer", async () => {
    transport.fetch.mockResolvedValue(Response.json({ registered: true }));
    await putPushDevice(session, "device-id", registration);
    await deletePushDevice(session, "device-id");
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of transport.fetch.mock.calls) {
      expect(url).toBe("https://front.test/api/baskule/push/devices/device-id");
      expect(init).toMatchObject({
        redirect: "error",
        credentials: "omit",
        headers: { authorization: "Bearer private-bearer" },
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.parse(String(transport.fetch.mock.calls[0]?.[1]?.body))).toEqual(registration);
  });
  it("validates server configuration and reports revoked sessions", async () => {
    transport.fetch.mockResolvedValueOnce(
      Response.json({ available: true, android: { appId: "test.app" }, ios: null, reason: null }),
    );
    expect((await fetchPushAvailability(session)).android?.appId).toBe("test.app");
    transport.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(fetchPushAvailability(session)).rejects.toMatchObject({ kind: "signed-out" });
    transport.fetch.mockResolvedValueOnce(Response.json({ available: true }));
    await expect(fetchPushAvailability(session)).rejects.toThrow();
  });
});
