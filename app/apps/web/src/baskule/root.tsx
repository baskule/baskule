// baskule: root-level pieces of the hosted multi-user build (sign-in gate, app-wide dialogs).
import { redirect } from "@tanstack/react-router";

import { SpaceManagementDialogHost } from "./SpaceManagementDialog";
import {
  adoptSessionUser,
  isBaskulePublicPath,
  loginPathFor,
  readBaskuleMe,
  refreshBaskuleMe,
  safeNextPath,
} from "./session";
import { baskule } from "./flags";

/** Login and invitation pages render without the app shell. */
export function isBaskuleBareRoute(pathname: string): boolean {
  return baskule.hosted && isBaskulePublicPath(pathname);
}

let sessionUserAdopted = false;

export async function baskuleBeforeLoad(location: {
  readonly pathname: string;
  readonly searchStr?: string;
}) {
  const search = location.searchStr ?? "";
  if (
    window.desktopBridge?.getBaskuleServer &&
    !window.desktopBridge.getBaskuleServer() &&
    location.pathname !== "/login"
  ) {
    throw redirect({ href: "/login", replace: true });
  }
  if (isBaskulePublicPath(location.pathname)) {
    // Someone already signed in who opens /login goes straight to the app.
    if (location.pathname.startsWith("/login") && !new URLSearchParams(search).has("server")) {
      const me = readBaskuleMe() ?? (await refreshBaskuleMe().catch(() => null));
      if (me !== null) {
        const next = new URLSearchParams(search).get("next");
        throw redirect({ href: safeNextPath(next), replace: true });
      }
    }
    return;
  }
  // A network failure keeps the app (cached chats, reconnect banners); only a 401 signs out.
  const me = readBaskuleMe() ?? (await refreshBaskuleMe().catch(() => undefined));
  if (me === null) {
    throw redirect({
      href: loginPathFor({ pathname: location.pathname, search }),
      replace: true,
    });
  }
  if (me && !sessionUserAdopted) {
    sessionUserAdopted = true;
    if ((await adoptSessionUser(me.user.id)) === "reloading") await new Promise(() => undefined);
  }
}

export function BaskuleRootChrome() {
  return <SpaceManagementDialogHost />;
}
