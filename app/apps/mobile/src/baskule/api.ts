/**
 * The Baskule front's account API, as a native client uses it (platform/README.md, "Sessions"):
 * Better Auth sign-in returns a signed bearer in `set-auth-token`; every later request sends
 * `Authorization: Bearer <token>` and no Origin.
 */
import type { BaskuleAuthConfig } from "@t3tools/contracts/baskule";

import { t } from "../i18n";
export interface BaskuleSpace {
  readonly id: string;
  readonly name: string;
  readonly kind: "personal" | "team";
  readonly role: "owner" | "member";
  /** `/s/<id>`: the space's T3 environment lives under it. */
  readonly base: string;
}

export interface BaskuleMe {
  readonly voiceInput: boolean;
  readonly authentication: BaskuleAuthConfig;
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly role: "admin" | "member";
  };
  readonly organization: { readonly id: string; readonly name: string };
  readonly spaces: ReadonlyArray<BaskuleSpace>;
}

export async function requestBrowserLogin(
  serverUrl: string,
  fetchFn: Fetch = fetch,
): Promise<{ id: string; secret: string; url: string }> {
  const r = await request(fetchFn, `${serverUrl}/api/baskule/native-login/request`, {
    method: "POST",
    credentials: "omit",
  });
  if (!r.ok) throw new BaskuleApiError("server", t("Could not start browser sign-in."));
  return (await r.json()) as { id: string; secret: string; url: string };
}

export async function pollBrowserLogin(
  serverUrl: string,
  pending: { id: string; secret: string },
  fetchFn: Fetch = fetch,
): Promise<string | null> {
  const r = await request(fetchFn, `${serverUrl}/api/baskule/native-login/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify(pending),
  });
  if (!r.ok) throw new BaskuleApiError("signed-out", t("Browser sign-in expired. Start again."));
  return ((await r.json()) as { token: string | null }).token;
}

export type BaskuleApiErrorKind =
  | "invalid-credentials"
  | "deactivated"
  | "rate-limited"
  | "signed-out"
  | "network"
  | "server";

export class BaskuleApiError extends Error {
  constructor(
    readonly kind: BaskuleApiErrorKind,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof globalThis.fetch;
const TIMEOUT_MS = 15_000;

async function request(fetchFn: Fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } catch {
    throw new BaskuleApiError(
      "network",
      t("Cannot reach the server. Check the address and this phone's network."),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function signIn(
  serverUrl: string,
  email: string,
  password: string,
  fetchFn: Fetch = fetch,
): Promise<string> {
  const response = await request(fetchFn, `${serverUrl}/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
    credentials: "omit",
  });
  if (response.status === 401 || response.status === 400) {
    throw new BaskuleApiError("invalid-credentials", t("Wrong email or password."));
  }
  if (response.status === 403) {
    throw new BaskuleApiError(
      "deactivated",
      t("This account is deactivated. Ask your administrator."),
    );
  }
  if (response.status === 429) {
    throw new BaskuleApiError(
      "rate-limited",
      t("Too many attempts. Wait a minute and try again."),
    );
  }
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) {
    throw new BaskuleApiError(
      "server",
      t("The server refused the sign-in (HTTP {{status}}).", { status: response.status }),
    );
  }
  return token;
}

/**
 * The installation's discovery document: proves the address is a Baskule server, names it and lists the login
 * methods it offers.
 */
export async function fetchInstance(
  serverUrl: string,
  fetchFn: Fetch = fetch,
): Promise<{ readonly name: string; readonly authentication: BaskuleAuthConfig }> {
  const response = await request(fetchFn, `${serverUrl}/.well-known/baskule`, {
    credentials: "omit",
  });
  const body = response.ok
    ? ((await response.json().catch(() => null)) as {
        product?: unknown;
        name?: unknown;
        authentication?: BaskuleAuthConfig;
      } | null)
    : null;
  if (body?.product !== "baskule" || !body.authentication) {
    throw new BaskuleApiError(
      "server",
      t("{{server}} is not a Baskule server.", { server: serverUrl }),
    );
  }
  return {
    name: typeof body.name === "string" ? body.name : "Baskule",
    authentication: body.authentication,
  };
}

/** Redeems a one-time connection code for a new session of the person who issued it. */
export async function redeemConnectCode(
  serverUrl: string,
  code: string,
  fetchFn: Fetch = fetch,
): Promise<string> {
  const response = await request(fetchFn, `${serverUrl}/auth/connect/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
    credentials: "omit",
  });
  if (response.status === 404 || response.status === 400) {
    throw new BaskuleApiError(
      "invalid-credentials",
      t("This connection link is not valid, has expired or was already used. Create a new one."),
    );
  }
  if (response.status === 429) {
    throw new BaskuleApiError(
      "rate-limited",
      t("Too many attempts. Wait a minute and try again."),
    );
  }
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) {
    throw new BaskuleApiError(
      "server",
      t("The server refused the connection (HTTP {{status}}).", { status: response.status }),
    );
  }
  return token;
}

export async function fetchMe(serverUrl: string, token: string, fetchFn: Fetch = fetch) {
  const response = await request(fetchFn, `${serverUrl}/api/baskule/me`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    credentials: "omit",
  });
  if (response.status === 401) {
    throw new BaskuleApiError("signed-out", t("Your session has ended. Sign in again."));
  }
  if (!response.ok) {
    throw new BaskuleApiError(
      "server",
      t("The server answered HTTP {{status}}.", { status: response.status }),
    );
  }
  return (await response.json()) as BaskuleMe;
}

/** Ends the session on the server; the device forgets the token whatever the answer. */
export async function signOut(serverUrl: string, token: string, fetchFn: Fetch = fetch) {
  await request(fetchFn, `${serverUrl}/auth/sign-out`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
    credentials: "omit",
  }).catch(() => undefined);
}
