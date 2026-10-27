import AsyncStorage from "@react-native-async-storage/async-storage";
import { decodePushPreferences } from "@t3tools/contracts/baskulePush";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import type { PushPreferences } from "@t3tools/contracts/baskulePush";
import type { PushSession } from "../../baskule/push-api";
import { deletePushDevice, fetchPushAvailability, putPushDevice } from "../../baskule/push-api";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import {
  clearAndroidAgentNotifications,
  configureAndroidAgentNotifications,
  supportsAndroidAgentNotifications,
} from "./androidNotifications";
import { createPushRegistrationController } from "./pushRegistrationController";

const preferences: PushPreferences = {
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
let currentPreferences = preferences;
let preferenceWrites = Promise.resolve();
let nativeToken: Notifications.DevicePushToken | null = null;
let nativeTokenLookup = false;
const controller = createPushRegistrationController({
  deviceId: loadOrCreateAgentAwarenessDeviceId,
  availability: fetchPushAvailability,
  put: putPushDevice,
  remove: deletePushDevice,
  configure: (deviceId, userId) => configureAndroidAgentNotifications(deviceId, userId, false),
  clear: clearAndroidAgentNotifications,
  nativeRegistration: async (preferences) => {
    const appId = Application.applicationId;
    if (
      !appId ||
      (Platform.OS !== "android" && Platform.OS !== "ios") ||
      (Platform.OS === "android" && !supportsAndroidAgentNotifications())
    )
      return null;
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return null;
    if (!nativeToken) {
      nativeTokenLookup = true;
      try {
        const fetched = await Notifications.getDevicePushTokenAsync();
        nativeToken ??= fetched;
      } finally {
        nativeTokenLookup = false;
      }
    }
    const native = nativeToken;
    if (typeof native.data !== "string" || native.type !== Platform.OS) return null;
    if (Platform.OS === "android")
      return { platform: "android", appId, token: native.data, preferences };
    const environment: unknown = Constants.expoConfig?.ios?.entitlements?.["aps-environment"];
    if (environment !== "development" && environment !== "production") return null;
    return {
      platform: "ios",
      appId,
      token: native.data,
      apnsEnvironment: environment === "development" ? "sandbox" : "production",
      preferences,
    };
  },
});
export const getBaskulePushState = controller.getState;
export const subscribeBaskulePush = controller.subscribe;
export const getBaskulePushPreferences = () => currentPreferences;
export const refreshBaskulePush = () => {
  nativeToken = null;
  return controller.refresh(currentPreferences);
};
export async function updateBaskulePushPreferences(
  next: PushPreferences | ((previous: PushPreferences) => PushPreferences),
) {
  const value = typeof next === "function" ? next(currentPreferences) : next;
  currentPreferences = value;
  const saved = preferenceWrites.then(() =>
    AsyncStorage.setItem("baskule.push-preferences", JSON.stringify(value)),
  );
  preferenceWrites = saved.catch(() => undefined);
  await Promise.all([saved, controller.refresh(value)]);
}
/** Call on every front session change, including revocation and disconnect. */
export function setBaskulePushSession(session: PushSession | null) {
  controller.setSession(session);
  return refreshBaskulePush();
}
/** Root installs once; returned cleanup removes listeners and clears the front identity. */
export function startBaskulePushRegistration() {
  clearAndroidAgentNotifications();
  const initial = currentPreferences;
  void AsyncStorage.getItem("baskule.push-preferences")
    .then((saved) => {
      if (saved && currentPreferences === initial) {
        currentPreferences = decodePushPreferences(JSON.parse(saved));
        void refreshBaskulePush();
      }
    })
    .catch(() => undefined);
  const token = Notifications.addPushTokenListener((token) => {
    if (nativeToken?.type === token.type && nativeToken.data === token.data) return;
    nativeToken = token;
    if (!nativeTokenLookup) void controller.refresh(currentPreferences);
  });
  const foreground = AppState.addEventListener("change", (state) => {
    if (state === "active") void refreshBaskulePush();
  });
  return () => {
    token.remove();
    foreground.remove();
    controller.setSession(null);
  };
}
