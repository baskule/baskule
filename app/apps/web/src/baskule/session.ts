// baskule: the signed-in person and their spaces (GET /api/baskule/me), shared by the
// bootstrap, the space connection source and the Baskule views. Re-read when the tab regains
// focus and every minute, so new spaces appear and removed ones disappear without a reload.
import { useSyncExternalStore } from "react";

import { type BaskuleMe, type BaskuleSpace, BaskuleApiError, baskuleApi } from "./api";

const REFRESH_INTERVAL_MS = 60_000;
/** Paths that render without a session. */
const PUBLIC_PATH_PATTERN = /^\/(login|invite|reset-password|link)\/?$/;

type Listener = () => void;

let current: BaskuleMe | null = null;
const listeners = new Set<Listener>();
let inflight: Promise<BaskuleMe | null> | null = null;
let watching = false;

/** Personal space first, then team spaces by name. */
export function orderSpaces(spaces: ReadonlyArray<BaskuleSpace>): ReadonlyArray<BaskuleSpace> {
  return [...spaces].toSorted((left, right) => {
    if (left.kind !== right.kind) return left.kind === "personal" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function sameMe(left: BaskuleMe | null, right: BaskuleMe | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publish(next: BaskuleMe | null) {
  const ordered = next === null ? null : { ...next, spaces: orderSpaces(next.spaces) };
  if (sameMe(current, ordered)) return;
  current = ordered;
  for (const listener of listeners) listener();
}

export function isBaskulePublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PATTERN.test(pathname);
}

export function loginPathFor(location: { readonly pathname: string; readonly search?: string }) {
  const next = `${location.pathname}${location.search ?? ""}`;
  return next === "/" || isBaskulePublicPath(location.pathname)
    ? "/login"
    : `/login?next=${encodeURIComponent(next)}`;
}

/** Only same-app paths are followed after sign-in. */
export function safeNextPath(raw: string | null | undefined): string {
  if (
    !raw ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.startsWith("/s/") ||
    /[\\\x00-\x20]/.test(raw)
  )
    return "/";
  return raw;
}

function goToLogin() {
  if (isBaskulePublicPath(window.location.pathname)) return;
  window.location.assign(loginPathFor(window.location));
}

/**
 * Loads the session. Resolves `null` when signed out. A network failure keeps the last known
 * session (the app keeps showing cached chats while the server is unreachable).
 */
export function refreshBaskuleMe(): Promise<BaskuleMe | null> {
  if (inflight) return inflight;
  inflight = baskuleApi
    .me()
    .then(
      (me) => {
        publish(me);
        return me;
      },
      (error: unknown) => {
        if (error instanceof BaskuleApiError && error.unauthenticated) {
          const wasSignedIn = current !== null;
          publish(null);
          if (wasSignedIn) goToLogin();
          return null;
        }
        if (current === null) throw error;
        return current;
      },
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function readBaskuleMe(): BaskuleMe | null {
  return current;
}

export function subscribeBaskuleMe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBaskuleMe(): BaskuleMe | null {
  return useSyncExternalStore(subscribeBaskuleMe, readBaskuleMe, readBaskuleMe);
}

/** Keeps the session fresh while the app runs. Idempotent. */
export function watchBaskuleSession() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const refresh = () => {
    if (document.visibilityState === "visible") void refreshBaskuleMe().catch(() => undefined);
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  window.setInterval(refresh, REFRESH_INTERVAL_MS);
  watchRevokedSpaceSockets(() => void refreshBaskuleMe().catch(() => undefined));
}

/** Close code of a space socket the server closed for revocation (platform/src/shared/recheck.ts). */
export const REVOKED_CLOSE_CODE = 4401;
export const isSpaceSocketUrl = (url: string) => /\/s\/[^/?#]+\/ws(?:[?#]|$)/.test(url);

/**
 * baskule(wp-h): when the front revokes a socket (removed from a space, signed out elsewhere, deactivated), refresh
 * `/me` at once: the space then leaves the UI with its cached chats within a second instead of at the next minute
 * tick. The sockets are opened by T3's transport, so this observes them through a WebSocket subclass.
 */
export function watchRevokedSpaceSockets(onRevoked: () => void) {
  const Native = window.WebSocket as typeof WebSocket & { readonly __baskuleWatched?: true };
  if (Native.__baskuleWatched) return;
  class WatchedWebSocket extends Native {
    static override readonly __baskuleWatched = true;
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (isSpaceSocketUrl(String(url))) {
        this.addEventListener("close", (event) => {
          if (event.code === REVOKED_CLOSE_CODE) onRevoked();
        });
      }
    }
  }
  window.WebSocket = WatchedWebSocket;
}

const LAST_USER_KEY = "baskule:last-user";

/**
 * One origin serves every person, so a shared browser profile must not keep the previous
 * person's cached chats. The front sends `Clear-Site-Data` on sign-out, but browsers ignore it
 * over plain HTTP (the Tailscale deployment), so the client clears its own storage too.
 */
export async function clearLocalAppData() {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable (private mode); nothing to clear then.
  }
  try {
    const databases = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      databases.flatMap((database) =>
        database.name
          ? [
              new Promise<void>((resolve) => {
                const request = indexedDB.deleteDatabase(database.name as string);
                for (const event of ["success", "error", "blocked"]) {
                  request.addEventListener(event, () => resolve());
                }
              }),
            ]
          : [],
      ),
    );
  } catch {
    // Same: best effort.
  }
}

/**
 * Called once the session is known. A different person than last time in this browser means
 * the local caches belong to someone else: clear them and start again from a clean load.
 */
export async function adoptSessionUser(userId: string): Promise<"continue" | "reloading"> {
  let previous: string | null = null;
  try {
    previous = window.localStorage.getItem(LAST_USER_KEY);
  } catch {
    return "continue";
  }
  if (previous === userId) return "continue";
  if (previous !== null) await clearLocalAppData();
  try {
    window.localStorage.setItem(LAST_USER_KEY, userId);
  } catch {
    // Best effort.
  }
  if (previous === null) return "continue";
  window.location.reload();
  return "reloading";
}

export async function signOutBaskule() {
  try {
    await baskuleApi.signOut();
  } finally {
    await clearLocalAppData();
    // A full load drops every socket, cached environment and in-memory state of this user.
    window.location.assign("/login");
  }
}

/** Test seam. */
export function __setBaskuleMeForTests(next: BaskuleMe | null) {
  current = next === null ? null : { ...next, spaces: orderSpaces(next.spaces) };
  for (const listener of listeners) listener();
}
