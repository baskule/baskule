// Better Auth 1.7.12 configuration for ControlCell (E6). Pinned exactly in package.json: minors have breaking cutovers.
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { admin, bearer, genericOAuth } from "better-auth/plugins";
import { socialProviders } from "better-auth/social-providers";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import type { InstallationAuth } from "./auth-config";
import { z } from "zod";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import * as authSchema from "./schema/auth";
import { hashPassword, verifyPassword } from "./password";
import { CLIENT_IP_HEADER } from "../shared/contract";

/** The admin plugin's roles. `admin` has no impersonation and no set-password/set-email/update (review M7):
 *  temporary passwords for never-signed-in accounts are set by our own code (ControlService.setInitialPassword). */
export const ac = createAccessControl(defaultStatements);
export const roles = {
  admin: ac.newRole({ user: ["create", "list", "set-role", "ban", "delete", "get"], session: ["list", "revoke", "delete"] }),
  member: ac.newRole({ user: [], session: [] }),
};

export interface AuthHooks {
  googleSignupDomains(): readonly string[];
  onUserCreated(user: { id: string; name: string; email: string }): Promise<void>;
  onSessionCreated(session: { id: string; userId: string }): Promise<void>;
  onSessionDeleted(session: { id: string; userId: string }): Promise<void>;
}

export interface AuthConfig {
  secret: string;
  publicOrigins: string[];
  rateLimit: boolean;
  installation: InstallationAuth;
}


/** Lifetime of a connect code: long enough to scan or paste it, short enough that a leaked one is useless. */
export const CONNECT_CODE_TTL_MS = 10 * 60_000;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function connectIdentifier(code: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));
  return `baskule-connect:${Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Connect codes (0.3 client connection): a signed-in person signs another device or browser in without typing a
 * password. `POST /auth/connect/code` (session) issues a 256-bit code valid once for CONNECT_CODE_TTL_MS, stored hashed in
 * Better Auth's `verification` table. `POST /auth/connect/redeem {code}` (public) consumes it and creates a NEW session
 * for that person: cookie for browsers and the desktop window, `set-auth-token` (bearer plugin) for mobile. A new session,
 * not the issuer's: signing the phone out must not sign the browser out.
 */
const connectCodes = () =>
  ({
    id: "baskule-connect",
    endpoints: {
      createConnectCode: createAuthEndpoint("/connect/code", { method: "POST", use: [sessionMiddleware] }, async (c) => {
        const code = b64url(crypto.getRandomValues(new Uint8Array(32)));
        const expiresAt = new Date(Date.now() + CONNECT_CODE_TTL_MS);
        await c.context.internalAdapter.createVerificationValue({
          identifier: await connectIdentifier(code),
          value: c.context.session.user.id,
          expiresAt,
        });
        return c.json({ code, expiresAt: expiresAt.getTime() });
      }),
      redeemConnectCode: createAuthEndpoint("/connect/redeem", { method: "POST", body: z.object({ code: z.string() }).partial() }, async (c) => {
        const code = c.body.code;
        const invalid = () => new APIError("NOT_FOUND", { message: "This connection link is not valid, has expired or was already used." });
        if (typeof code !== "string" || code.length < 20 || code.length > 200) throw invalid();
        const v = await c.context.internalAdapter.consumeVerificationValue(await connectIdentifier(code));
        if (!v || new Date(v.expiresAt) < new Date()) throw invalid();
        const user = await c.context.internalAdapter.findUserById(v.value);
        if (!user || (user as { banned?: boolean | null }).banned) throw invalid();
        const session = await c.context.internalAdapter.createSession(user.id);
        await setSessionCookie(c, { session, user });
        return c.json({ user: { id: user.id, email: user.email, name: user.name } });
      }),
    },
  }) as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuth(db: any, cfg: AuthConfig, hooks: AuthHooks) {
  const social: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  for (const p of cfg.installation.providers.filter(p => p.type === "social")) {
    if (!Object.hasOwn(socialProviders, p.id)) throw new Error(`Unsupported social provider: ${p.id}`);
    Object.assign(social, { [p.id]: { ...p.options, disableSignUp: p.id !== "google", ...(p.id === "microsoft" ? { disableProfilePhoto: true } : {}) } });
  }
  return betterAuth({
    appName: "Baskule",
    basePath: "/auth",
    secret: cfg.secret,
    // Public TLS may terminate before ControlCell. Local installations infer their URL from each request.
    baseURL: cfg.installation.publicOrigin,
    trustedOrigins: (request?: Request) => {
      const list = [...cfg.publicOrigins];
      if (cfg.installation.publicOrigin) list.push(cfg.installation.publicOrigin);
      else if (request) {
        try { list.push(new URL(request.url).origin); } catch {}
      }
      return list;
    },
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    socialProviders: social,
    // Existing accounts can link a proven email (or an explicitly trusted provider).
    account: { encryptOAuthTokens: true, accountLinking: { enabled: true, requireLocalEmailVerified: false, trustedProviders: cfg.installation.trustedProviders } },
    user: { validateUserInfo: async ({ user, source }) => {
      if (source.action === "create-user" && source.method === "oauth") {
        const domain = user.email?.split("@")[1]?.toLowerCase();
        if (source.oauth?.providerId === "google" && user.emailVerified === true && domain && source.oauth.profile?.hd === domain && hooks.googleSignupDomains().includes(domain))
          return;
        return { error: "invitation_required", errorDescription: "Accept an invitation or use a Google account with an allowed email domain." };
      }
    } },
    emailAndPassword: {
      enabled: cfg.installation.mode === "authenticated" && cfg.installation.password,
      disableSignUp: true, // no public sign-up; accounts come from the admin or an invitation
      minPasswordLength: 8,
      maxPasswordLength: 256,
      password: { hash: hashPassword, verify: verifyPassword },
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
    },
    session: {
      // Never cache sessions in cookies: revocation must be immediate (auth-and-libraries §1, review H5).
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: cfg.rateLimit,
      storage: "memory", // ControlCell is a singleton: memory is the whole installation
      window: 60,
      max: 200,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/reset-password": { window: 60, max: 10 },
        "/change-password": { window: 60, max: 10 },
        "/connect/redeem": { window: 60, max: 10 },
      },
    },
    advanced: {
      cookiePrefix: "baskule",
      // The Worker strips every inbound x-baskule-* and sets this from the connection (review L2).
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    telemetry: { enabled: false },
    plugins: [
      admin({ ac, roles, defaultRole: "member", adminRoles: ["admin"] }),
      bearer({ requireSignature: true }), // a raw DB token is not a login (review L1)
      connectCodes(),
      genericOAuth({ config: cfg.installation.providers.filter(p => p.type === "oidc").map(p => ({
        ...p.options, providerId: p.id, name: p.name,
        requireIdTokenVerification: true, disableSignUp: true,
      } as unknown as GenericOAuthConfig)) }),
    ],
    databaseHooks: {
      // Login ID tokens are validated before persistence. We need only the encrypted access/refresh pair afterwards.
      account: {
        create: { before: async (account) => ({ data: { ...account, idToken: null } }) },
        update: { before: async (account) => ({ data: { ...account, idToken: null } }) },
      },
      user: {
        create: { after: async (user) => hooks.onUserCreated(user) },
      },
      session: {
        create: { after: async (s) => hooks.onSessionCreated(s) },
        delete: { after: async (s) => hooks.onSessionDeleted(s) },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
