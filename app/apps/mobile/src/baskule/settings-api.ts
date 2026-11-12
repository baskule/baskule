import { PLUGIN_CATEGORIES, type MemberPlugin } from "@t3tools/contracts/baskule-plugins";
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
const memberConnection = Schema.Union([
  Schema.Struct({ state: Schema.Literal("not_required") }),
  Schema.Struct({ state: Schema.Literal("not_connected") }),
  Schema.Struct({
    state: Schema.Literal("connected"),
    account: Schema.NullOr(Schema.String),
    connectedAt: Schema.String,
  }),
  Schema.Struct({ state: Schema.Literal("expired") }),
  Schema.Struct({ state: Schema.Literal("unavailable") }),
]);
const memberPlugins = Schema.Struct({
  plugins: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        displayName: Schema.String,
        description: Schema.String,
        logo: Schema.NullOr(Schema.String),
        category: Schema.NullOr(Schema.Literals(PLUGIN_CATEGORIES)),
        on: Schema.Boolean,
        enabled: Schema.Boolean,
        servers: Schema.mutable(
          Schema.Array(
            Schema.Struct({ id: Schema.String, name: Schema.String, connection: memberConnection }),
          ),
        ),
        skillCount: Schema.Number,
      }),
    ),
  ),
});
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
    case "plugin_not_found":
    case "server_not_found":
      return t("The plugin changed or was removed in the meantime. Reload and try again.");
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

/** The member's own switch: off keeps the assistant from using the plugin for them. */
export async function setPluginOn(
  session: SettingsSession,
  input: { readonly pluginId: string; readonly on: boolean },
): Promise<void> {
  await request(session, `/api/baskule/plugins/${encodeURIComponent(input.pluginId)}`, "PUT", {
    on: input.on,
  });
}

export async function disconnectPluginServer(
  session: SettingsSession,
  input: { readonly pluginId: string; readonly serverId: string },
): Promise<void> {
  await request(
    session,
    `/api/baskule/plugins/${encodeURIComponent(input.pluginId)}/servers/${encodeURIComponent(input.serverId)}/connection`,
    "DELETE",
  );
}
