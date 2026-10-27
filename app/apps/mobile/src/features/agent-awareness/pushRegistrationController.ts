import type {
  PushAvailability,
  PushPreferences,
  PushRegistration,
} from "@t3tools/contracts/baskulePush";
import type { PushSession } from "../../baskule/push-api";

export type PushRegistrationState = {
  readonly status: "signed-out" | "checking" | "unavailable" | "disabled" | "registered" | "failed";
  readonly reason: string | null;
};
export interface PushRegistrationDependencies {
  deviceId(): Promise<string>;
  availability(session: PushSession): Promise<PushAvailability>;
  nativeRegistration(preferences: PushPreferences): Promise<PushRegistration | null>;
  put(session: PushSession, deviceId: string, registration: PushRegistration): Promise<void>;
  remove(session: PushSession, deviceId: string): Promise<void>;
  configure(deviceId: string, userId: string): void;
  clear(): void;
}

export function createPushRegistrationController(deps: PushRegistrationDependencies) {
  let session: PushSession | null = null;
  let generation = 0;
  let revision = 0;
  let queue = Promise.resolve();
  let state: PushRegistrationState = { status: "signed-out", reason: null };
  let registration: { session: PushSession; deviceId: string } | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: PushRegistrationState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const refresh = (preferences: PushPreferences) => {
    const current = session,
      version = generation,
      request = ++revision;
    const active = () => generation === version && session === current && revision === request;
    const work = async () => {
      if (!current || !active()) return;
      publish({ status: "checking", reason: null });
      try {
        const config = await deps.availability(current);
        if (!active()) return;
        if (!config.available || !preferences.notificationsEnabled) {
          await deps.remove(current, registration?.deviceId ?? (await deps.deviceId()));
          if (!active()) return;
          registration = null;
          deps.clear();
          publish({ status: config.available ? "disabled" : "unavailable", reason: config.reason });
          return;
        }
        const native = await deps.nativeRegistration(preferences);
        if (!active()) return;
        if (
          !native ||
          (native.platform === "ios"
            ? config.ios?.appId !== native.appId ||
              !config.ios.environments.includes(native.apnsEnvironment)
            : config.android?.appId !== native.appId)
        ) {
          await deps.remove(current, registration?.deviceId ?? (await deps.deviceId()));
          if (!active()) return;
          registration = null;
          deps.clear();
          publish({
            status: "unavailable",
            reason:
              "This app build or notification permission does not match the server push configuration.",
          });
          return;
        }
        const deviceId = await deps.deviceId();
        if (!active()) return;
        await deps.put(current, deviceId, native);
        if (!active()) {
          await deps.remove(current, deviceId).catch(() => undefined);
          return;
        }
        registration = { session: current, deviceId };
        deps.configure(deviceId, current.userId);
        publish({ status: "registered", reason: null });
      } catch {
        if (active()) {
          deps.clear();
          publish({
            status: "failed",
            reason:
              "Could not register this device with the server. It will retry when the app returns to the foreground.",
          });
        }
      }
    };
    queue = queue.then(work, work);
    return queue;
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setSession(next: PushSession | null) {
      if (
        session?.serverUrl === next?.serverUrl &&
        session?.userId === next?.userId &&
        session?.token === next?.token
      )
        return;
      const old = session;
      session = next;
      generation++;
      deps.clear();
      publish({ status: next ? "checking" : "signed-out", reason: null });
      const cleanup = async () => {
        if (!old) return;
        const deviceId = registration?.deviceId ?? (await deps.deviceId());
        await deps.remove(old, deviceId).catch(() => undefined);
        registration = null;
      };
      queue = queue.then(cleanup, cleanup);
    },
    refresh,
    settled: () => queue,
  };
}
