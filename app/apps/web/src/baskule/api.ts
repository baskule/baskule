import { t } from "../i18n";
// baskule: typed client for the Baskule front (Worker + ControlCell, architecture E6/E7).
// Same origin, cookie session (Better Auth at `/auth/*`); our API at `/api/baskule/*`.
// Wire shapes: platform/README.md ("/api/baskule") and platform/src/control/service.ts (WP-C).
// The views use the small view models below; mapping from the wire happens here only.
import type {
  BaskuleAIConnectionCheck,
  BaskuleAuthConfig,
  BaskuleAdminSettings,
  BaskuleAvailableModel,
  BaskuleProductSettings,
  BaskuleTranscriptionResult,
} from "@t3tools/contracts/baskule";
export type {
  BaskuleAIConnectionCheck,
  BaskuleAuthConfig,
  BaskuleAdminSettings,
  BaskuleAvailableModel,
  BaskuleProductSettings,
} from "@t3tools/contracts/baskule";

export type OrgRole = "admin" | "member";
export type SpaceRole = "owner" | "member";
export type SpaceKind = "personal" | "team";

export interface BaskuleUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: OrgRole;
}

export interface BaskuleSpace {
  readonly id: string;
  readonly name: string;
  readonly kind: SpaceKind;
  /** The caller's role in the space. */
  readonly role: SpaceRole;
  /** Path prefix of the space's environment, `/s/<id>`. */
  readonly base: string;
}

export interface BaskuleMe {
  readonly authentication: BaskuleAuthConfig;
  readonly user: BaskuleUser;
  readonly organizationName: string | null;
  /** The caller's spaces, personal first. */
  readonly spaces: ReadonlyArray<BaskuleSpace>;
  /** Admins and members whose groups grant space creation. */
  readonly canCreateSpaces: boolean;
  /** Transcription is enabled and a key is saved for its connection. */
  readonly voiceInput: boolean;
}

/** "invited": an account created with a temporary password that was never used to sign in. */
export type PersonStatus = "active" | "invited" | "deactivated";

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly status: PersonStatus;
  readonly activeSessions: number;
}

export interface PendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly expiresAt: number;
}

export interface SpaceMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: SpaceRole;
}

export interface SpaceDetails {
  readonly id: string;
  readonly name: string;
  readonly kind: SpaceKind;
  readonly members: ReadonlyArray<SpaceMember>;
}

export type ComputerState = "running" | "starting" | "stopped" | "stopping" | "error" | "unknown";

export interface SpaceStatusView {
  /** The space cell is loaded (T3 server running). */
  readonly awake: boolean;
  readonly sockets: number;
  readonly activeRuns: number;
  readonly computer: ComputerState;
  readonly error: string | null;
}

/** One row of the admin overview: every space, team members or the personal space's owner. */
export interface AdminSpace {
  readonly id: string;
  readonly name: string;
  readonly kind: SpaceKind;
  readonly memberCount: number;
  readonly ownerName: string | null;
  readonly members: ReadonlyArray<SpaceMember>;
  /** Null when never checked. */
  readonly status: SpaceStatusView | null;
  readonly checkedAt: number | null;
}

export interface Invitation {
  readonly email: string;
  readonly role: OrgRole;
  readonly expiresAt: number;
  readonly spaces: ReadonlyArray<{ readonly id: string; readonly name: string | null }>;
}

export interface Download {
  readonly id: string;
  readonly fileName: string;
  readonly label: string;
  readonly platform: "linux" | "windows" | "macos" | "android" | "other";
  readonly format: string;
  readonly url: string;
  readonly sizeBytes: number | null;
  readonly version: string | null;
}

export class BaskuleApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.name = "BaskuleApiError";
    this.status = status;
    this.code = code;
  }
  get unauthenticated(): boolean {
    return this.status === 401;
  }
}

const NETWORK_ERROR_MESSAGE = "Can't reach the server. Check your connection and try again.";

/** Readable text for the codes the platform returns (`{error: code, message?}`). */
const CODE_MESSAGES: Record<string, string> = {
  get last_admin() {
    return t("Keep at least one admin.");
  },
  last_owner: "A team space keeps at least one owner.",
  get self() {
    return t("You can't do that to your own account.");
  },
  get user_exists() {
    return t("Someone already has an account with this email.");
  },
  get already_member() {
    return t("Already a member of this space.");
  },
  get already_signed_in() {
    return t("This person has signed in already: create a reset link instead.");
  },
  get invalid_email() {
    return t("Enter a valid email address.");
  },
  get invalid_password() {
    return t("Use a password of at least 8 characters.");
  },
  get invalid_invitation() {
    return t("This invitation link is not valid, has expired or was already used.");
  },
  get space_wipe_failed() {
    return t("The space could not be wiped. Try again.");
  },
  get stop_failed() {
    return t("The space did not stop. Try again.");
  },
  get personal_space() {
    return t("Personal spaces have exactly one member.");
  },
  get forbidden() {
    return t("You don't have permission to do that.");
  },
  get not_found() {
    return t("Not found.");
  },
  get unauthenticated() {
    return t("You are signed out.");
  },
  get voice_input_disabled() {
    return t("Voice input is turned off for your organization.");
  },
  get audio_too_large() {
    return t("The recording is too long to transcribe.");
  },
  get invalid_audio() {
    return t("The recording could not be read. Try again.");
  },
  get transcription_failed() {
    return t("The recording could not be transcribed. Try again.");
  },
  get transcription_key_rejected() {
    return t("The transcription provider rejected the API key. Ask an admin to check AI → Voice input.");
  },
  get shared_api_key() {
    return t("This key is shared with chat. Change it on AI → Models.");
  },
  get ai_key_missing() {
    return t("Enter this provider's API key.");
  },
  get ai_key_rejected() {
    return t("The provider rejected this API key.");
  },
  get ai_model_not_found() {
    return t("This key has no access to this model. Choose another model.");
  },
  get ai_provider_unreachable() {
    return t("Could not reach the provider. Check the API endpoint.");
  },
  get usage_limit_reached() {
    return t("Usage limit reached");
  },
  get too_many_requests() {
    return t("Too many attempts. Wait a minute and try again.");
  },
};

export function messageFromBody(
  body: unknown,
  status: number,
): { message: string; code: string | null } {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const code =
      typeof record.code === "string"
        ? record.code
        : typeof record.error === "string"
          ? record.error
          : null;
    const known = code ? CODE_MESSAGES[code] : undefined;
    if (known) return { message: known, code };
    if (typeof record.message === "string" && record.message) {
      const text = record.message;
      return { message: text.charAt(0).toUpperCase() + text.slice(1), code };
    }
    if (code) return { message: code.replaceAll("_", " "), code };
  }
  if (status === 401) return { message: t("You are signed out."), code: null };
  if (status === 403) return { message: t("You don't have permission to do that."), code: null };
  if (status === 404) return { message: t("Not found."), code: null };
  return { message: t("The server answered {{status}}.", { status: status }), code: null };
}

/** A JSON body, or a Blob sent as is with its own type as content-type. */
export async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers:
        body === undefined
          ? { accept: "application/json" }
          : {
              accept: "application/json",
              "content-type":
                body instanceof Blob ? body.type || "application/octet-stream" : "application/json",
            },
      ...(body === undefined ? {} : { body: body instanceof Blob ? body : JSON.stringify(body) }),
    });
  } catch {
    throw new BaskuleApiError(0, NETWORK_ERROR_MESSAGE, "network");
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const { message, code } = messageFromBody(parsed, response.status);
    throw new BaskuleApiError(response.status, message, code);
  }
  return parsed as T;
}

const enc = encodeURIComponent;

interface WireMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: SpaceRole;
}

interface WireUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly banned: boolean;
  readonly firstSignInAt: number | null;
  readonly activeSessions: number;
}

export function personFromWire(user: WireUser): Person {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role === "admin" ? "admin" : "member",
    status: user.banned ? "deactivated" : user.firstSignInAt ? "active" : "invited",
    activeSessions: Number(user.activeSessions) || 0,
  };
}

const COMPUTER_STATES = new Set<ComputerState>([
  "running",
  "starting",
  "stopped",
  "stopping",
  "error",
]);

/** The computer state comes from computerd through the SpaceCell; accept its `{phase}` payload and older string/state shapes. */
export function computerStateFrom(value: unknown): ComputerState {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? ((value as Record<string, unknown>).phase ??
          (value as Record<string, unknown>).state ??
          (value as Record<string, unknown>).status ??
          (typeof (value as Record<string, unknown>).error === "string" ? "error" : undefined))
        : null;
  if (raw === null || raw === undefined) return value === null ? "stopped" : "unknown";
  const normalized = String(raw).toLowerCase();
  if (COMPUTER_STATES.has(normalized as ComputerState)) return normalized as ComputerState;
  if (normalized === "ready" || normalized === "awake" || normalized === "up") return "running";
  if (normalized === "asleep" || normalized === "absent" || normalized === "none") return "stopped";
  if (normalized === "provisioning" || normalized === "waking") return "starting";
  return "unknown";
}

export function statusFromWire(status: unknown): SpaceStatusView | null {
  if (!status || typeof status !== "object") return null;
  const record = status as Record<string, unknown>;
  if (typeof record.error === "string" && !("awake" in record)) {
    return { awake: false, sockets: 0, activeRuns: 0, computer: "unknown", error: record.error };
  }
  return {
    awake: Boolean(record.awake),
    sockets: Number(record.sockets) || 0,
    activeRuns: Number(record.activeRuns) || 0,
    computer: computerStateFrom(record.computer),
    error: typeof record.error === "string" ? record.error : null,
  };
}

/** Platform and format of a published file, from its name (`Baskule-0.2.0-x86_64.AppImage`). */
export function describeDownload(file: {
  readonly name: string;
  readonly size?: number;
  readonly url: string;
}): Download {
  const name = file.name;
  const lower = name.toLowerCase();
  const format = lower.endsWith(".tar.gz")
    ? "tar.gz"
    : lower.endsWith(".appimage")
      ? "AppImage"
      : (name.split(".").at(-1) ?? "file");
  const platform: Download["platform"] = lower.endsWith(".apk")
    ? "android"
    : /\.(exe|msi)$/.test(lower) || lower.includes("win")
      ? "windows"
      : /\.(dmg|pkg)$/.test(lower) || lower.includes("mac") || lower.includes("darwin")
        ? "macos"
        : /appimage|linux|\.deb$|\.rpm$|\.tar\.gz$/.test(lower)
          ? "linux"
          : "other";
  const version = /(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)[0-9.]*)?)/i.exec(name)?.[1] ?? null;
  const labels: Record<Download["platform"], string> = {
    linux: t("Baskule for Linux"),
    windows: t("Baskule for Windows"),
    macos: t("Baskule for macOS"),
    android: t("Baskule for Android"),
    other: name,
  };
  return {
    id: name,
    fileName: name,
    label: labels[platform],
    platform,
    format,
    url: file.url,
    sizeBytes: typeof file.size === "number" ? file.size : null,
    version,
  };
}

interface WireMe {
  readonly authentication: BaskuleAuthConfig;
  readonly user: BaskuleUser & { readonly canCreateSpaces?: boolean };
  readonly organization?: { readonly name?: string } | null;
  readonly voiceInput?: boolean;
  readonly spaces: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly role: SpaceRole;
    readonly base?: string;
  }>;
}

export function meFromWire(me: WireMe): BaskuleMe {
  return {
    authentication: me.authentication,
    user: { id: me.user.id, name: me.user.name, email: me.user.email, role: me.user.role },
    organizationName: me.organization?.name ?? null,
    spaces: me.spaces.map((space) => ({
      id: space.id,
      name: space.name,
      kind: space.kind === "personal" ? "personal" : "team",
      role: space.role,
      base: space.base ?? `/s/${enc(space.id)}`,
    })),
    canCreateSpaces: me.user.role === "admin" || Boolean(me.user.canCreateSpaces),
    voiceInput: me.voiceInput === true,
  };
}

const spaceDetails = async (spaceId: string): Promise<SpaceDetails> => {
  const result = await request<{
    readonly space: { readonly id: string; readonly name: string; readonly kind: string };
    readonly members: ReadonlyArray<WireMember>;
  }>("GET", `/api/baskule/spaces/${enc(spaceId)}`);
  return {
    id: result.space.id,
    name: result.space.name,
    kind: result.space.kind === "personal" ? "personal" : "team",
    members: result.members,
  };
};

export const baskuleApi = {
  authConfig: async () =>
    (await request<{ readonly authentication: BaskuleAuthConfig }>("GET", "/.well-known/baskule"))
      .authentication,
  requestBrowserLogin: () =>
    request<{ id: string; secret: string; url: string }>(
      "POST",
      "/api/baskule/native-login/request",
    ),
  pollBrowserLogin: (pending: { id: string; secret: string }) =>
    request<{ token: string | null }>("POST", "/api/baskule/native-login/poll", pending),
  adminSettings: () => request<BaskuleAdminSettings>("GET", "/api/baskule/admin/settings"),
  /** An empty key clears the saved one. */
  saveSettings: (
    settings: BaskuleProductSettings & { apiKey?: string; transcriptionApiKey?: string },
  ) => request<BaskuleAdminSettings>("PATCH", "/api/baskule/admin/settings", settings),
  aiModels: async (connection: BaskuleAIConnectionCheck) =>
    (
      await request<{ readonly models: BaskuleAvailableModel[] }>(
        "POST",
        "/api/baskule/admin/ai/models",
        connection,
      )
    ).models,
  /** Resolves when the provider accepts the key and model; rejects with the reason otherwise. */
  verifyAI: (check: BaskuleAIConnectionCheck & { readonly modelId: string }) =>
    request<{ readonly ok: true }>("POST", "/api/baskule/admin/ai/verify", check),
  providerSignIn: (provider: BaskuleAuthConfig["providers"][number], next = "/") =>
    request<{ url: string }>("POST", "/auth/sign-in/social", {
      provider: provider.id,
      callbackURL: next,
      errorCallbackURL: "/login?error=provider",
      disableRedirect: true,
    }),
  // Session (Better Auth).
  signIn: (input: { readonly email: string; readonly password: string }) =>
    request<unknown>("POST", "/auth/sign-in/email", { ...input, rememberMe: true }),
  signOut: () => request<unknown>("POST", "/auth/sign-out", {}),
  changePassword: (input: { readonly currentPassword: string; readonly newPassword: string }) =>
    request<unknown>("POST", "/auth/change-password", { ...input, revokeOtherSessions: true }),
  resetPassword: (input: { readonly token: string; readonly newPassword: string }) =>
    request<unknown>("POST", "/auth/reset-password", input),

  me: async () => meFromWire(await request<WireMe>("GET", "/api/baskule/me")),
  /** The recording's MIME type travels as its content-type. */
  transcribe: async (recording: Blob) =>
    (await request<BaskuleTranscriptionResult>("POST", "/api/baskule/transcriptions", recording))
      .text,

  // Invitations (public; the token travels in the link's fragment).
  invitation: async (token: string): Promise<Invitation> => {
    const result = await request<{
      readonly email: string;
      readonly role: string;
      readonly expiresAt: number;
      readonly spaces?: ReadonlyArray<{ readonly id: string; readonly name: string | null }>;
    }>("POST", "/api/baskule/invitations/lookup", { token });
    return {
      email: result.email,
      role: result.role === "admin" ? "admin" : "member",
      expiresAt: result.expiresAt,
      spaces: result.spaces ?? [],
    };
  },
  acceptInvitation: (token: string, input: { readonly name: string; readonly password: string }) =>
    request<unknown>("POST", "/api/baskule/invitations/accept", { token, ...input }),
  createConnectCode: () =>
    request<{ readonly code: string; readonly expiresAt: number }>(
      "POST",
      "/auth/connect/code",
      {},
    ),
  redeemConnectCode: (code: string) => request<unknown>("POST", "/auth/connect/redeem", { code }),
  acceptProviderInvitation: (token: string, name: string, provider: string) =>
    request<unknown>("POST", "/api/baskule/invitations/accept", { token, name, provider }),

  space: spaceDetails,
  createSpace: async (input: { readonly name: string }): Promise<SpaceDetails> => {
    const result = await request<{
      readonly space: { readonly id: string; readonly name: string };
      readonly members: ReadonlyArray<WireMember>;
    }>("POST", "/api/baskule/spaces", input);
    return { id: result.space.id, name: result.space.name, kind: "team", members: result.members };
  },
  renameSpace: async (spaceId: string, input: { readonly name: string }) => {
    await request<unknown>("PATCH", `/api/baskule/spaces/${enc(spaceId)}`, input);
    return spaceDetails(spaceId);
  },
  deleteSpace: (spaceId: string) =>
    request<unknown>("DELETE", `/api/baskule/spaces/${enc(spaceId)}`),
  addMember: async (
    spaceId: string,
    input: { readonly userId: string; readonly role: SpaceRole },
  ) => {
    await request<unknown>("POST", `/api/baskule/spaces/${enc(spaceId)}/members`, input);
    return spaceDetails(spaceId);
  },
  setMemberRole: async (spaceId: string, userId: string, input: { readonly role: SpaceRole }) => {
    await request<unknown>(
      "PATCH",
      `/api/baskule/spaces/${enc(spaceId)}/members/${enc(userId)}`,
      input,
    );
    return spaceDetails(spaceId);
  },
  /** Also used to leave a space (the member themself). */
  removeMember: (spaceId: string, userId: string) =>
    request<unknown>("DELETE", `/api/baskule/spaces/${enc(spaceId)}/members/${enc(userId)}`),
  /** Active people of the organisation (to add as members). */
  directory: async () =>
    (
      await request<{
        readonly people: ReadonlyArray<{
          readonly id: string;
          readonly name: string;
          readonly email: string;
        }>;
      }>("GET", "/api/baskule/people")
    ).people,

  // Admin: people.
  people: async () =>
    (
      await request<{ readonly users: ReadonlyArray<WireUser> }>("GET", "/api/baskule/admin/users")
    ).users.map(personFromWire),
  createPerson: async (input: {
    readonly name: string;
    readonly email: string;
    readonly role: OrgRole;
    readonly temporaryPassword: string;
  }) =>
    personFromWire(
      (
        await request<{ readonly user: WireUser }>("POST", "/api/baskule/admin/users", {
          name: input.name,
          email: input.email,
          role: input.role,
          password: input.temporaryPassword,
        })
      ).user,
    ),
  updatePerson: (userId: string, input: { readonly role?: OrgRole }) =>
    request<unknown>("PATCH", `/api/baskule/admin/users/${enc(userId)}`, input),
  setDeactivated: (userId: string, deactivated: boolean) =>
    request<unknown>(
      "POST",
      `/api/baskule/admin/users/${enc(userId)}/${deactivated ? "deactivate" : "activate"}`,
      {},
    ),
  deletePerson: (userId: string) =>
    request<unknown>("DELETE", `/api/baskule/admin/users/${enc(userId)}`),
  signOutPerson: (userId: string) =>
    request<unknown>("POST", `/api/baskule/admin/users/${enc(userId)}/sign-out-everywhere`, {}),
  /** Only for someone who never signed in. */
  setTemporaryPassword: (userId: string, password: string) =>
    request<unknown>("POST", `/api/baskule/admin/users/${enc(userId)}/password`, { password }),
  /** A one-hour reset link; using it signs the person out everywhere. */
  resetLink: (userId: string) =>
    request<{ readonly url: string }>(
      "POST",
      `/api/baskule/admin/users/${enc(userId)}/reset-link`,
      {},
    ),

  // Admin: invitations.
  invite: (input: {
    readonly email: string;
    readonly role: OrgRole;
    readonly spaces?: ReadonlyArray<{ readonly spaceId: string; readonly role?: SpaceRole }>;
  }) =>
    request<{ readonly url: string; readonly expiresAt: number }>(
      "POST",
      "/api/baskule/invitations",
      input,
    ),
  invitations: async (): Promise<ReadonlyArray<PendingInvitation>> => {
    const result = await request<{
      readonly invitations: ReadonlyArray<{
        readonly id: string;
        readonly email: string;
        readonly role: string;
        readonly expiresAt: number;
        readonly acceptedAt: number | null;
        readonly revokedAt: number | null;
      }>;
    }>("GET", "/api/baskule/invitations");
    const now = Date.now();
    return result.invitations
      .filter(
        (invitation) =>
          !invitation.acceptedAt && !invitation.revokedAt && invitation.expiresAt > now,
      )
      .map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role === "admin" ? "admin" : "member",
        expiresAt: invitation.expiresAt,
      }));
  },
  revokeInvitation: (invitationId: string) =>
    request<unknown>("DELETE", `/api/baskule/invitations/${enc(invitationId)}`),

  // Admin: spaces and health.
  adminSpaces: async (options?: {
    readonly live?: boolean;
  }): Promise<ReadonlyArray<AdminSpace>> => {
    const result = await request<{
      readonly spaces: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly kind: string;
        readonly memberCount: number;
        readonly owner?: { readonly name: string | null } | null;
        readonly members?: ReadonlyArray<WireMember> | null;
        readonly status: unknown;
        readonly checkedAt: number | null;
      }>;
    }>("GET", `/api/baskule/admin/spaces${options?.live ? "?status=live" : ""}`);
    return result.spaces.map((space) => ({
      id: space.id,
      name: space.name,
      kind: space.kind === "personal" ? "personal" : "team",
      memberCount: Number(space.memberCount) || 0,
      ownerName: space.owner?.name ?? null,
      members: space.members ?? [],
      status: statusFromWire(space.status),
      checkedAt: space.checkedAt ?? null,
    }));
  },
  stopSpace: (spaceId: string) =>
    request<unknown>("POST", `/api/baskule/admin/spaces/${enc(spaceId)}/stop`, {}),

  downloads: async (): Promise<ReadonlyArray<Download>> =>
    (
      await request<{
        readonly files: ReadonlyArray<{
          readonly name: string;
          readonly size?: number;
          readonly url: string;
        }>;
      }>("GET", "/api/baskule/downloads")
    ).files.map(describeDownload),
};

/** `<origin><base>/`: where a space's T3 environment is served (E7). */
export function spaceBaseUrl(origin: string, base: string): string {
  return `${origin.replace(/\/+$/, "")}/${base.replace(/^\/+|\/+$/g, "")}/`;
}
