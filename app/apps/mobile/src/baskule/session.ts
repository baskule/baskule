import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { t } from "../i18n";
import * as Api from "./api";
import { normalizeServerUrl } from "./config";
import { decodeSavedConnection, type SavedConnection } from "./saved-connection";

const TOKEN_KEY = "baskule.session-token";
const CONNECTION_KEY = "baskule.connection";
const REFRESH_MS = 60_000;

export type BaskuleSession =
  | { readonly status: "loading" }
  | { readonly status: "signed-out"; readonly serverUrl: string | null; readonly notice?: string }
  | {
      readonly status: "signed-in";
      readonly kind: "authenticated" | "anonymous";
      readonly serverUrl: string;
      readonly token: string;
      readonly me: Api.BaskuleMe;
    };

let state: BaskuleSession = { status: "loading" };
let revision = 0;
let writes: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function publish(next: BaskuleSession) {
  state = next;
  for (const listener of listeners) listener();
}

export const readBaskuleSession = () => state;
export function subscribeBaskuleSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useBaskuleSession(): BaskuleSession {
  return useSyncExternalStore(subscribeBaskuleSession, readBaskuleSession, readBaskuleSession);
}

async function persist(next: BaskuleSession) {
  if (next.status === "loading") return;
  const saved: SavedConnection =
    next.status === "signed-out"
      ? { kind: "disconnected", serverUrl: next.serverUrl }
      : { kind: next.kind, serverUrl: next.serverUrl, me: next.me };
  if (next.status === "signed-in" && next.kind === "authenticated") {
    await SecureStore.setItemAsync(TOKEN_KEY, next.token);
  } else {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  }
  await AsyncStorage.setItem(CONNECTION_KEY, JSON.stringify(saved));
}

function commit(next: BaskuleSession, expected: number): Promise<void> {
  const work = writes.then(async () => {
    if (revision !== expected) return;
    try {
      await persist(next);
    } catch (error) {
      await persist(state);
      throw error;
    }
    if (revision !== expected) {
      await persist(state);
      return;
    }
    publish(next);
  });
  writes = work.catch(() => undefined);
  return work;
}

export function cancelBaskuleSignIn() {
  revision++;
}

let loading: Promise<void> | null = null;
export function loadBaskuleSession(): Promise<void> {
  loading ??= (async () => {
    const expected = revision;
    const raw = await AsyncStorage.getItem(CONNECTION_KEY).catch(() => null);
    let saved: SavedConnection = { kind: "disconnected", serverUrl: null };
    try {
      if (raw) saved = decodeSavedConnection(raw);
    } catch {
    }
    const token =
      saved.kind === "authenticated"
        ? await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null)
        : "";
    if (revision !== expected) return;
    if (saved.kind === "disconnected" || token === null) {
      publish({ status: "signed-out", serverUrl: saved.serverUrl });
    } else {
      publish({
        status: "signed-in",
        kind: saved.kind,
        serverUrl: saved.serverUrl,
        token,
        me: saved.me,
      });
      void refreshBaskuleMe();
    }
  })();
  startRefreshing();
  return loading;
}

export async function refreshBaskuleMe(): Promise<void> {
  const current = state;
  const expected = revision;
  if (current.status !== "signed-in") return;
  try {
    const me = await Api.fetchMe(current.serverUrl, current.token);
    if (revision !== expected || state !== current) return;
    if (JSON.stringify(me) !== JSON.stringify(current.me)) {
      await commit({ ...current, me }, expected);
    }
  } catch (error) {
    if (
      revision === expected &&
      state === current &&
      error instanceof Api.BaskuleApiError &&
      error.kind === "signed-out"
    ) {
      const next = {
        status: "signed-out",
        serverUrl: current.serverUrl,
        notice: error.message,
      } as const;
      publish(next);
      await commit(next, ++revision);
    }
  }
}

async function finishSignIn(serverUrl: string, token: string, expected: number) {
  if (revision !== expected) return;
  const me = await Api.fetchMe(serverUrl, token);
  await commit(
    { status: "signed-in", kind: token ? "authenticated" : "anonymous", serverUrl, token, me },
    expected,
  );
}

export async function signInToBaskule(input: {
  readonly serverUrl: string;
  readonly email: string;
  readonly password: string;
}): Promise<void> {
  const expected = ++revision;
  const serverUrl = normalizeServerUrl(input.serverUrl);
  if (serverUrl === null)
    throw new Api.BaskuleApiError(
      "network",
      t("Enter the server address, e.g. https://baskule.example.com"),
    );
  await Api.fetchInstance(serverUrl);
  const token = await Api.signIn(serverUrl, input.email, input.password);
  await finishSignIn(serverUrl, token, expected);
}

export async function connectToBaskule(input: {
  readonly serverUrl: string;
  readonly code: string;
}): Promise<void> {
  const expected = ++revision;
  const token = await Api.redeemConnectCode(input.serverUrl, input.code);
  await finishSignIn(input.serverUrl, token, expected);
}

export async function connectAnonymously(serverUrl: string): Promise<void> {
  const expected = ++revision;
  if ((await Api.fetchInstance(serverUrl)).authentication.mode !== "anonymous")
    throw new Api.BaskuleApiError("server", t("This installation requires sign-in."));
  await finishSignIn(serverUrl, "", expected);
}

export async function completeBaskuleSignIn(serverUrl: string, token: string): Promise<void> {
  await finishSignIn(serverUrl, token, ++revision);
}

export async function signOutOfBaskule(): Promise<void> {
  const current = state;
  if (current.status !== "signed-in") return;
  const expected = ++revision;
  const next = { status: "signed-out", serverUrl: current.serverUrl } as const;
  publish(next);
  await commit(next, expected);
  if (current.kind === "authenticated") await Api.signOut(current.serverUrl, current.token);
}

let refreshing = false;
function startRefreshing() {
  if (refreshing) return;
  refreshing = true;
  setInterval(() => void refreshBaskuleMe(), REFRESH_MS);
  AppState.addEventListener("change", (next) => {
    if (next === "active") void refreshBaskuleMe();
  });
}
