import type { MemberPlugin } from "@t3tools/contracts/baskule-plugins";
import { UsageWindowStatusSchema, type MyUsage } from "@t3tools/contracts/baskule-usage";
import * as Schema from "effect/Schema";
import { fetch } from "expo/fetch";

import { t } from "../i18n";
import { BaskuleApiError } from "./api";

export interface SettingsSession {
  readonly serverUrl: string;
  readonly token: string;
}

const amount = Schema.Struct({ tokens: Schema.Number, costUsd: Schema.Number });
const myUsage = Schema.Struct({
  limits: Schema.mutable(Schema.Array(UsageWindowStatusSchema)),
  totals: Schema.Struct({ today: amount, week: amount, month: amount }),
  daily: Schema.mutable(
    Schema.Array(Schema.Struct({ ...amount.fields, date: Schema.String, turns: Schema.Number })),
  ),
  byModel: Schema.mutable(
    Schema.Array(
      Schema.Struct({ ...amount.fields, provider: Schema.String, model: Schema.String }),
    ),
  ),
});
const pluginStatus = Schema.Literals([
  "unavailable",
  "needs_setup",
  "connect",
  "reconnect",
  "ready",
]);
const memberPlugins = Schema.Struct({
  plugins: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        description: Schema.String,
        icon: Schema.optional(Schema.String),
        skills: Schema.mutable(
          Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
        ),
        status: pluginStatus,
        servers: Schema.mutable(
          Schema.Array(
            Schema.Struct({
              name: Schema.String,
              credential: Schema.Literals(["none", "organization", "user-oauth"]),
              status: pluginStatus,
              accounts: Schema.mutable(
                Schema.Array(
                  Schema.Struct({
                    id: Schema.String,
                    label: Schema.String,
                    default: Schema.Boolean,
                    status: Schema.Literals(["ready", "reconnect"]),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
});
const mutationResult = Schema.Struct({ ok: Schema.Literal(true) });
const errorBody = Schema.Struct({
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

export class BaskuleSettingsError extends BaskuleApiError {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(
      status === 401
        ? "signed-out"
        : status === 429
          ? "rate-limited"
          : code === "INVALID_PASSWORD"
            ? "invalid-credentials"
            : "server",
      message,
    );
  }
}

function errorMessage(status: number, code: string | undefined): string {
  if (status === 401) return t("Your session has ended. Sign in again.");
  if (status === 429) return t("Too many attempts. Wait a minute and try again.");
  switch (code) {
    case "INVALID_PASSWORD":
      return t("The current password is not right.");
    case "PASSWORD_TOO_SHORT":
      return t("Use at least 8 characters for your new password.");
    case "PASSWORD_TOO_LONG":
      return t("Use no more than 256 characters for your new password.");
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return t("This account does not have a password. Use your sign-in provider.");
    case "account_label_taken":
      return t("You already have an account with this name.");
    case "account_not_found":
      return t("This account is no longer connected. Reload the page.");
    case "default_account_required":
      return t("Choose which account becomes your default before you disconnect this one.");
    case "connection_not_allowed":
      return t("The plugin changed or was paused in the meantime. Reload the page and try again.");
    case "invalid_plugin_input":
      return t("Some details aren't valid. Check them and try again.");
    default:
      return t("The server answered HTTP {{status}}.", { status });
  }
}

async function request(
  session: SettingsSession,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${session.serverUrl}${path}`, {
      method,
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new BaskuleApiError("network", t("Cannot reach the server. Check this phone's network."));
  }
  if (!response.ok) {
    let code: string | undefined;
    try {
      const value: unknown = await response.json();
      const parsed = Schema.decodeUnknownSync(errorBody)(value);
      code = parsed.code ?? parsed.error;
    } catch {}
    throw new BaskuleSettingsError(response.status, code, errorMessage(response.status, code));
  }
  return response;
}

async function decodeResponse<S extends Schema.Top & { readonly DecodingServices: never }>(
  response: Response,
  schema: S,
): Promise<S["Type"]> {
  try {
    const value: unknown = await response.json();
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new BaskuleApiError("server", t("The server sent an invalid response. Try again."));
  }
}

/** The signed replacement token must be persisted before making another authenticated request. */
export async function changeBaskulePassword(
  session: SettingsSession,
  input: { readonly currentPassword: string; readonly newPassword: string },
): Promise<string> {
  const response = await request(session, "/auth/change-password", "POST", {
    ...input,
    revokeOtherSessions: true,
  });
  const token = response.headers.get("set-auth-token");
  // Better Auth's JSON token is unsigned and cannot authenticate a native client.
  if (!token)
    throw new BaskuleApiError(
      "signed-out",
      t("Password changed. Sign in again with your new password."),
    );
  return token;
}

export async function fetchMyUsage(session: SettingsSession): Promise<MyUsage> {
  return decodeResponse(await request(session, "/api/baskule/usage/me"), myUsage);
}

export async function fetchMemberPlugins(session: SettingsSession): Promise<MemberPlugin[]> {
  return (await decodeResponse(await request(session, "/api/baskule/plugins"), memberPlugins))
    .plugins;
}

export async function updatePluginAccount(
  session: SettingsSession,
  input: {
    readonly pluginId: string;
    readonly accountId: string;
    readonly patch: { readonly label: string } | { readonly default: true };
  },
): Promise<void> {
  await decodeResponse(
    await request(
      session,
      `/api/baskule/plugins/${encodeURIComponent(input.pluginId)}/accounts/${encodeURIComponent(input.accountId)}`,
      "PATCH",
      input.patch,
    ),
    mutationResult,
  );
}

export async function disconnectPluginAccount(
  session: SettingsSession,
  input: { readonly pluginId: string; readonly accountId: string; readonly newDefault?: string },
): Promise<void> {
  const query =
    input.newDefault === undefined ? "" : `?default=${encodeURIComponent(input.newDefault)}`;
  await decodeResponse(
    await request(
      session,
      `/api/baskule/plugins/${encodeURIComponent(input.pluginId)}/accounts/${encodeURIComponent(input.accountId)}${query}`,
      "DELETE",
    ),
    mutationResult,
  );
}
