import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DevicePushToken } from "expo-notifications";
const native = vi.hoisted(() => ({
  appId: "test.app",
  token: "first-token",
  os: "android",
  permissions: true,
  aps: "development" as string | undefined,
  tokenListener: null as ((token: DevicePushToken) => void) | null,
  getToken: vi.fn<() => Promise<DevicePushToken>>(),
  foreground: null as ((state: string) => void) | null,
  removeToken: vi.fn(),
  removeForeground: vi.fn(),
  configure: vi.fn(),
  clear: vi.fn(),
  put: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  availability: {
    available: true,
    android: { appId: "test.app" },
    ios: { appId: "test.app", environments: ["sandbox", "production"] },
    reason: null,
  },
}));
vi.mock("expo-application", () => ({
  get applicationId() {
    return native.appId;
  },
}));
vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return { ios: { entitlements: { "aps-environment": native.aps } } };
    },
  },
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => ({ granted: native.permissions }),
  getDevicePushTokenAsync: native.getToken,
  addPushTokenListener: (listener: (token: DevicePushToken) => void) => {
    native.tokenListener = listener;
    return { remove: native.removeToken };
  },
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  AppState: {
    addEventListener: (_: string, listener: (state: string) => void) => {
      native.foreground = listener;
      return { remove: native.removeForeground };
    },
  },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}));
vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: async () => "device-id",
}));
vi.mock("../../baskule/push-api", () => ({
  fetchPushAvailability: async () => native.availability,
  putPushDevice: native.put,
  deletePushDevice: native.remove,
}));
vi.mock("./androidNotifications", () => ({
  supportsAndroidAgentNotifications: () => true,
  configureAndroidAgentNotifications: native.configure,
  clearAndroidAgentNotifications: native.clear,
}));
const session = { serverUrl: "https://front.test", token: "front-bearer", userId: "alice" };
function queueTokenLookup() {
  native.getToken.mockImplementationOnce(async () => {
    const token: DevicePushToken = {
      type: native.os === "ios" ? "ios" : "android",
      data: native.token,
    };
    native.tokenListener?.(token);
    return token;
  });
}
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  native.os = "android";
  native.token = "first-token";
  native.permissions = true;
  native.aps = "development";
  native.tokenListener = null;
  native.foreground = null;
  native.getToken.mockReset().mockRejectedValue(new Error("Unexpected extra token lookup"));
  queueTokenLookup();
});

describe("native Baskule push lifecycle", () => {
  it("uses the device token and installed app identity, refreshes rotation and foreground, and clears on disconnect", async () => {
    const registration = await import("./baskuleRegistration");
    const stop = registration.startBaskulePushRegistration();
    await registration.setBaskulePushSession(session);
    expect(registration.getBaskulePushState().status).toBe("registered");
    expect(native.getToken).toHaveBeenCalledTimes(1);
    expect(native.put).toHaveBeenCalledTimes(1);
    expect(native.put).toHaveBeenCalledWith(
      session,
      "device-id",
      expect.objectContaining({ platform: "android", appId: "test.app", token: "first-token" }),
    );
    expect(native.configure).toHaveBeenCalledWith("device-id", "alice", false);
    const registered = () =>
      new Promise<void>((resolve) => {
        const unsubscribe = registration.subscribeBaskulePush(() => {
          if (registration.getBaskulePushState().status === "registered") {
            unsubscribe();
            resolve();
          }
        });
      });
    const rotated = registered();
    native.tokenListener?.({ type: "android", data: "rotated" });
    await rotated;
    expect(native.getToken).toHaveBeenCalledTimes(1);
    expect(native.put).toHaveBeenLastCalledWith(
      session,
      "device-id",
      expect.objectContaining({ token: "rotated" }),
    );
    native.tokenListener?.({ type: "android", data: "rotated" });
    expect(registration.getBaskulePushState().status).toBe("registered");
    native.token = "foreground-token";
    queueTokenLookup();
    const resumed = registered();
    native.foreground?.("active");
    await resumed;
    expect(native.getToken).toHaveBeenCalledTimes(2);
    expect(native.put).toHaveBeenCalledTimes(3);
    expect(native.put).toHaveBeenLastCalledWith(
      session,
      "device-id",
      expect.objectContaining({ token: "foreground-token" }),
    );
    await registration.setBaskulePushSession(null);
    expect(native.remove).toHaveBeenCalledWith(session, "device-id");
    expect(registration.getBaskulePushState().status).toBe("signed-out");
    stop();
    expect(native.removeToken).toHaveBeenCalled();
    expect(native.removeForeground).toHaveBeenCalled();
  });
  it("registers a listener rotation only for the current front identity without another lookup", async () => {
    const registration = await import("./baskuleRegistration");
    const stop = registration.startBaskulePushRegistration();
    await registration.setBaskulePushSession(session);
    expect(registration.getBaskulePushState().status).toBe("registered");
    const bob = { ...session, token: "bob-bearer", userId: "bob" };
    const registered = new Promise<void>((resolve) => {
      const unsubscribe = registration.subscribeBaskulePush(() => {
        if (registration.getBaskulePushState().status === "registered") {
          unsubscribe();
          resolve();
        }
      });
    });
    const switched = registration.setBaskulePushSession(bob);
    native.tokenListener?.({ type: "android", data: "bob-rotated" });
    await switched;
    await registered;
    expect(native.getToken).toHaveBeenCalledTimes(1);
    expect(native.put).toHaveBeenCalledTimes(2);
    expect(native.put).toHaveBeenLastCalledWith(
      bob,
      "device-id",
      expect.objectContaining({ token: "bob-rotated" }),
    );
    expect(native.remove).toHaveBeenCalledWith(session, "device-id");
    expect(native.configure).toHaveBeenLastCalledWith("device-id", "bob", false);
    stop();
  });
  it("uses an explicit APNs environment and reports a missing build entitlement as unavailable", async () => {
    native.os = "ios";
    native.token = "a".repeat(64);
    const registration = await import("./baskuleRegistration");
    await registration.setBaskulePushSession(session);
    expect(native.put).toHaveBeenCalledWith(
      session,
      "device-id",
      expect.objectContaining({
        platform: "ios",
        apnsEnvironment: "sandbox",
        token: "a".repeat(64),
      }),
    );
    native.aps = undefined;
    queueTokenLookup();
    await registration.refreshBaskulePush();
    expect(registration.getBaskulePushState().status).toBe("unavailable");
    expect(native.remove).toHaveBeenCalledWith(session, "device-id");
  });
});
