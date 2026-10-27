import { describe, expect, it, vi } from "vite-plus/test";
import {
  createPushRegistrationController,
  type PushRegistrationDependencies,
} from "./pushRegistrationController";
import type { PushPreferences, PushRegistration } from "@t3tools/contracts/baskulePush";

const preferences: PushPreferences = {
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const alice = { serverUrl: "https://front.test", token: "a", userId: "alice" };
const bob = { ...alice, token: "b", userId: "bob" };
const native: PushRegistration = {
  platform: "android",
  appId: "test.app",
  token: "native-token",
  preferences,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup() {
  const deps = {
    deviceId: async () => "device-id",
    availability: async () => ({
      available: true,
      ios: null,
      android: { appId: "test.app" },
      reason: null,
    }),
    nativeRegistration: vi.fn(async (): Promise<PushRegistration | null> => native),
    put: vi.fn<PushRegistrationDependencies["put"]>(async () => {}),
    remove: vi.fn(async () => {}),
    configure: vi.fn(),
    clear: vi.fn(),
  };
  return { deps, controller: createPushRegistrationController(deps) };
}

describe("Baskule push registration", () => {
  it("registers the current front identity and rotates native tokens on refresh", async () => {
    const { deps, controller } = setup();
    controller.setSession(alice);
    await controller.refresh(preferences);
    expect(controller.getState().status).toBe("registered");
    expect(deps.configure).toHaveBeenLastCalledWith("device-id", "alice");
    deps.nativeRegistration.mockResolvedValue({ ...native, token: "rotated" });
    await controller.refresh(preferences);
    expect(deps.put).toHaveBeenLastCalledWith(alice, "device-id", { ...native, token: "rotated" });
    await controller.refresh({ ...preferences, notificationsEnabled: false });
    expect(deps.remove).toHaveBeenCalledWith(alice, "device-id");
    expect(controller.getState().status).toBe("disabled");
  });
  it("drops an old account token lookup and configures only the new identity", async () => {
    const { deps, controller } = setup();
    const token = deferred<PushRegistration | null>(),
      started = deferred<void>();
    deps.nativeRegistration.mockImplementationOnce(() => {
      started.resolve();
      return token.promise;
    });
    controller.setSession(alice);
    const old = controller.refresh(preferences);
    await started.promise;
    controller.setSession(bob);
    const fresh = controller.refresh(preferences);
    token.resolve(native);
    await old;
    await fresh;
    expect(deps.put).toHaveBeenCalledTimes(1);
    expect(deps.put.mock.calls[0]?.[0]).toEqual(bob);
    expect(deps.configure).toHaveBeenCalledTimes(1);
    expect(deps.configure).toHaveBeenLastCalledWith("device-id", "bob");
  });
  it("removes an in-flight registration before switching account and clears on revocation", async () => {
    const { deps, controller } = setup();
    const send = deferred<void>(),
      started = deferred<void>();
    deps.put.mockImplementationOnce(() => {
      started.resolve();
      return send.promise;
    });
    controller.setSession(alice);
    const old = controller.refresh(preferences);
    await started.promise;
    controller.setSession(bob);
    const fresh = controller.refresh(preferences);
    send.resolve();
    await old;
    await fresh;
    expect(deps.remove).toHaveBeenCalledWith(alice, "device-id");
    expect(deps.configure).toHaveBeenCalledTimes(1);
    expect(deps.configure).toHaveBeenCalledWith("device-id", "bob");
    controller.setSession(null);
    expect(controller.getState().status).toBe("signed-out");
    await controller.settled();
    expect(deps.remove).toHaveBeenLastCalledWith(bob, "device-id");
    expect(deps.clear).toHaveBeenCalled();
  });
  it("requires matching server and native configuration and retries transient failures", async () => {
    const { deps, controller } = setup();
    controller.setSession(alice);
    deps.nativeRegistration.mockResolvedValueOnce({ ...native, appId: "other.app" });
    await controller.refresh(preferences);
    expect(controller.getState().status).toBe("unavailable");
    expect(deps.put).not.toHaveBeenCalled();
    deps.put.mockRejectedValueOnce(new Error("offline"));
    await controller.refresh(preferences);
    expect(controller.getState().status).toBe("failed");
    await controller.refresh(preferences);
    expect(controller.getState().status).toBe("registered");
  });
});

it("registers the new account even when the old DELETE is offline", async () => {
  const { deps, controller } = setup();
  controller.setSession(alice);
  await controller.refresh(preferences);
  deps.remove.mockRejectedValueOnce(new Error("offline cleanup"));
  controller.setSession(bob);
  await controller.refresh(preferences);
  expect(controller.getState().status).toBe("registered");
  expect(deps.put).toHaveBeenLastCalledWith(bob, "device-id", native);
  expect(deps.configure).toHaveBeenLastCalledWith("device-id", "bob");
});
