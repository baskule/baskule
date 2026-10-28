import type { NavigationState, PartialState } from "@react-navigation/native";

import { BASKULE_FLAGS } from "../baskule/flags";

export function isConnectAppLink(url: string): boolean {
  return /^baskule(?:-dev|-preview)?:\/\/connect(?:[/?#]|$)/i.test(url);
}

export function shouldHandleAppLink(value: string, cloudConfigured = false): boolean {
  if (isConnectAppLink(value)) return false;
  try {
    const url = new URL(value);
    if (!/^(baskule|t3code)(-dev|-preview)?:$/.test(url.protocol) && url.protocol !== "exp:")
      return false;
    const path = `${url.hostname}/${url.pathname}`.replace(/\/+/g, "/");
    if (path.includes("expo-development-client") || path.includes("expo-sharing")) return false;
    if (/^\/*$/.test(path)) return false;
    if (!BASKULE_FLAGS.pullRequests && /(^|\/)pull-requests(\/|$)/.test(path)) return false;
    if (!BASKULE_FLAGS.terminal && /^threads\/[^/]+\/[^/]+\/terminal(?:\/|$)/.test(path))
      return false;
    if (
      !BASKULE_FLAGS.sourceControl &&
      /^threads\/[^/]+\/[^/]+\/(?:review|review-comment|git|git-confirm)(?:\/|$)/.test(path)
    )
      return false;
    if (!BASKULE_FLAGS.devicePreviews && /^threads\/[^/]+\/[^/]+\/devices(?:\/|$)/.test(path))
      return false;
    return cloudConfigured || !CLOUD_ONLY_LINK_PATH.test(value.split(/[?#]/)[0] ?? "");
  } catch {
    return false;
  }
}

/**
 * Screens that only exist with T3 Connect configured. A build without it has
 * no entry points to them, so a link must not open one empty. Anchored to the
 * app-relative path (after `exp://host/--/` in Expo Go) so a file route whose
 * path merely ends in one of these names still opens.
 */
const CLOUD_ONLY_LINK_PATH =
  /^[a-z][\w+.-]*:\/*(?:[^/]*\/--\/)?(?:connect-onboarding|settings\/(?:auth|waitlist))\/*$/i;

/** Keep the published draft URLs while using the root thread screen. */
export function restoreDraftLinkState(
  state: PartialState<NavigationState> | undefined,
  path: string,
) {
  const pathname = path.split("?")[0]?.replace(/^\/+|\/+$/g, "");
  if (!state || !pathname || !/^new\/draft(?:\/|$)/.test(pathname)) return state;
  const target = state.routes.at(-1);
  if (!target) return state;
  const draft = target.params ?? {};
  const routes = state.routes.slice(0, -1);
  routes.push({ name: "Thread", params: { draft } });
  if (pathname !== "new/draft") routes.push(target);
  return { ...state, index: routes.length - 1, routes };
}

type LinkState = PartialState<NavigationState>;
type LinkRoute = LinkState["routes"][number];

function isLinkState(value: unknown): value is LinkState {
  return typeof value === "object" && value !== null && Array.isArray((value as LinkState).routes);
}

/** The first route named one of `names`, at any nesting depth of a parsed link. */
export function findLinkedRoute(
  state: LinkState | undefined,
  names: ReadonlyArray<string>,
): LinkRoute | undefined {
  for (const route of state?.routes ?? []) {
    if (names.includes(route.name)) return route;
    const nested = isLinkState(route.state) ? findLinkedRoute(route.state, names) : undefined;
    if (nested) return nested;
  }
  return undefined;
}
