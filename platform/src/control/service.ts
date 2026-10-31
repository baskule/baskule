import { ConnectionCipher } from "./connection-crypto";
// ControlService: all ControlCell logic (identity, spaces, invitations, admin, authorization, revocation).
// Independent of the DO runtime so it runs under vitest with a fake `ctx.storage` (test/unit/fake-storage.ts).
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./migrations/migrations.js";
import * as authSchema from "./schema/auth";
import * as appSchema from "./schema/app";
import { createAuth, type Auth } from "./auth";
import { hashPassword } from "./password";
import { parseAuthConfig, publicAuthConfig } from "./auth-config";
import { UsageService } from "./usage";
import { defaultSettings, parseConnectionCheck, parseSettings, type ProductSettings } from "./settings";
import { AIModels, type AIConnection } from "./ai-models";
import { BASKULE_AI_PROVIDERS } from "../../../app/packages/contracts/src/baskule";
import { Push } from "./push";
import { Groups } from "./groups";
import { Connections } from "./connections";
import { Plugins } from "./plugins";
import { pluginCredential } from "./plugin-credential";
import { readBounded } from "./registries/http";
import { BASKULE_TRANSCRIPTION_MAX_BYTES } from "../../../app/packages/contracts/src/baskule";
import {
  INTERNAL_HEADER,
  CLIENT_IP_HEADER,
  SPACE_CONTROL,
  WELL_KNOWN_PATH,
  spaceBase,
  type CheckRequest,
  type CheckResponse,
  type Identity,
  type RevokeRequest,
  type SpaceRole,
  type UserRole,
} from "../shared/contract";
import { HttpError, SPACE_ID_RE, errorResponse, json, notFound, readJson } from "../shared/http";
import type { Env } from "../env";

export interface SqlCursor {
  toArray(): Record<string, unknown>[];
}
export interface StorageLike {
  sql: { exec(query: string, ...params: unknown[]): SqlCursor };
  transactionSync<T>(fn: () => T): T;
}

/** Calls a SpaceCell control route: env.SPACE.getByName(spaceId).fetch("http://space" + path, init). */
export type SpaceCaller = (spaceId: string, path: string, init?: RequestInit) => Promise<Response>;


const REVOKE_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MS = 3_000;
const INVITE_DEFAULT_HOURS = 7 * 24;
const PERSONAL_SPACE_NAME = "Personal";
const TRANSCRIPTION_TIMEOUT_MS = 120_000;
const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/ogg": "ogg",
  "audio/wav": "wav", "audio/x-m4a": "m4a", "audio/m4a": "m4a",
  "audio/flac": "flac", "audio/x-wav": "wav", "audio/wave": "wav", "audio/aac": "aac",
};

type Row = Record<string, unknown>;
interface SessionUser {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
}
interface Session {
  session: { id: string; userId: string };
  user: SessionUser;
}

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const newId = () => crypto.randomUUID().replace(/-/g, "");
async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}
const normEmail = (e: unknown) => (typeof e === "string" ? e.trim().toLowerCase() : "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const userRole = (r: unknown): UserRole => (r === "admin" ? "admin" : "member");
const str = (v: unknown, field: string, max = 200): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, "invalid_field", `${field} is required (≤${max} chars)`);
  return v.trim();
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export class ControlService {
  readonly db;
  readonly usage: UsageService;
  readonly aiModels = new AIModels();
  auth!: Auth;
  orgId = "";
  readonly installation;
  readonly push: Push;
  readonly groups;
  plugins!: Plugins;
  connections!: Connections;
  /** In-flight revocation calls; every request waits for them before answering (immediate revocation). */
  private pending = new Set<Promise<unknown>>();
  private nativeStarts = new Map<string, { until: number; count: number }>();
  private transcriptions = new Set<string>();
  /** Log of revocations sent (for tests and debugging; bounded). */
  readonly revocationLog: { spaceId: string; body: RevokeRequest }[] = [];

  constructor(
    private storage: StorageLike,
    private env: Env,
    private callSpace: SpaceCaller,
  ) {
    this.usage = new UsageService(storage, callSpace);
    this.installation = parseAuthConfig(env.AUTH_CONFIG);
    this.push = new Push(storage, callSpace, this.installation.mode === "authenticated");
    this.groups = new Groups(storage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.db = drizzle(storage as any, { schema: { ...authSchema, ...appSchema } });
  }

  // ---------------------------------------------------------------- SQL helpers
  private all(q: string, ...p: unknown[]): Row[] {
    return this.storage.sql.exec(q, ...p).toArray();
  }
  private one(q: string, ...p: unknown[]): Row | undefined {
    return this.all(q, ...p)[0];
  }
  private run(q: string, ...p: unknown[]): void {
    this.all(q, ...p); // always drain cursors (celld refuses output while a write cursor is open)
  }

  // ---------------------------------------------------------------- boot
  /** Runs in blockConcurrencyWhile: migrations, auth secret, organisation, first admin. */
  async init(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(this.db as any, migrations);
    this.groups.init();
    const mode = this.one("select value from kv where key='auth_mode'")?.value;
    if (mode && mode !== this.installation.mode) throw new Error("Changing authentication mode requires wiping alpha data");
    this.run("insert or ignore into kv(key, value) values ('auth_mode', ?)", this.installation.mode);
    let secret = this.env.AUTH_SECRET || (this.one("select value from kv where key='auth_secret'")?.value as string | undefined);
    if (!secret) {
      secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
      this.run("insert into kv(key, value) values ('auth_secret', ?)", secret);
    }
    const origins = (this.env.PUBLIC_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    this.auth = createAuth(this.db, { secret, publicOrigins: origins, rateLimit: this.env.AUTH_RATE_LIMIT !== "0", installation: this.installation }, {
      googleSignupDomains: () => this.productSettings().googleSignupDomains,
      onUserCreated: async (u) => this.onUserCreated(u),
      onSessionCreated: async (s) => this.onSessionCreated(s),
      onSessionDeleted: async (s) => this.onSessionDeleted(s),
    });
    const cipher = new ConnectionCipher(secret);
    this.plugins = new Plugins(this.storage, this.groups, cipher);
    this.connections = new Connections(this.storage, this.plugins, this.auth, this.installation, cipher);
    this.plugins.connections = this.connections;
    const org = this.one("select id from organization order by created_at limit 1");
    if (org) this.orgId = org.id as string;
    else {
      this.orgId = newId();
      this.run("insert into organization(id, name, created_at) values (?, ?, ?)", this.orgId, defaultSettings.organizationName, Date.now());
    }
    if (this.installation.mode === "anonymous") {
      if (!this.one("select id from user where id='anonymous'")) {
        const now = Date.now();
        this.run("insert into user(id, name, email, role, created_at, updated_at) values ('anonymous', 'Anonymous', 'anonymous@baskule.invalid', 'admin', ?, ?)", now, now);
        await this.onUserCreated({ id: "anonymous", name: "Anonymous", email: "anonymous@baskule.invalid" });
        this.run("update space set name='Shared' where personal_user_id='anonymous'");
      }
    } else await this.bootstrapAdmin();
  }

  private productSettings(): ProductSettings {
    const saved = this.one("select value from kv where key='product_settings'");
    return saved ? parseSettings(JSON.parse(saved.value as string)) : defaultSettings;
  }

  private apiKeySlot(providerId: string, baseUrl: string) {
    return `llm_api_key:${JSON.stringify([providerId, baseUrl])}`;
  }

  private savedApiKey(providerId: string, baseUrl: string): string {
    const value = this.one("select value from kv where key=?", this.apiKeySlot(providerId, baseUrl))?.value;
    return typeof value === "string" ? value : "";
  }

  /** The connection an admin is checking: the key they typed, else the one saved for the provider and endpoint. */
  private async connectionCheck(req: Request): Promise<{ connection: AIConnection; modelId?: string }> {
    const { providerId, baseUrl, apiKey, modelId } = parseConnectionCheck(await readJson(req));
    const key = BASKULE_AI_PROVIDERS[providerId].keyless ? "public" : apiKey ?? this.savedApiKey(providerId, baseUrl);
    return { connection: { providerId, baseUrl, key }, ...(modelId === undefined ? {} : { modelId }) };
  }

  private transcriptionConnection(settings = this.productSettings().transcription) {
    const value = this.one("select value from kv where key=?", this.apiKeySlot(settings.providerId, settings.baseUrl))?.value;
    const key = typeof value === "string" ? value : "";
    return { voiceInput: settings.enabled && !!key, key, baseUrl: settings.baseUrl, model: settings.model };
  }

  private settingsView() {
    const settings = this.productSettings();
    return { ...settings, apiKeyConfigured: !!(BASKULE_AI_PROVIDERS[settings.ai.providerId].keyless || this.one("select value from kv where key=?", this.apiKeySlot(settings.ai.providerId, settings.ai.baseUrl))?.value),
      transcriptionApiKeyConfigured: !!this.transcriptionConnection(settings.transcription).key,
      authentication: publicAuthConfig(this.installation) };
  }

  private async saveSettings(req: Request): Promise<Response> {
    const { apiKey, transcriptionApiKey, ...input } = await readJson<Record<string, unknown>>(req);
    const settings = parseSettings(input);
    const previous = this.productSettings().ai;
    const chatSlot = this.apiKeySlot(settings.ai.providerId, settings.ai.baseUrl);
    const transcriptionSlot = this.apiKeySlot(settings.transcription.providerId, settings.transcription.baseUrl);
    if (transcriptionApiKey === "" && transcriptionSlot === chatSlot)
      throw new HttpError(400, "shared_api_key", "This key is shared with chat; change it on AI → Models");
    const keys = new Map<string, string>();
    for (const [slot, key] of [[chatSlot, apiKey], [transcriptionSlot, transcriptionApiKey]] as const) {
      if (key === undefined) continue;
      if (typeof key !== "string" || key.length > 8192) throw new HttpError(400, "invalid_api_key");
      if (slot === chatSlot && BASKULE_AI_PROVIDERS[settings.ai.providerId].keyless) continue;
      if (keys.has(slot) && keys.get(slot) !== key) throw new HttpError(400, "conflicting_api_keys");
      keys.set(slot, key);
    }
    const chatKey = this.savedApiKey(settings.ai.providerId, settings.ai.baseUrl);
    const nextChatKey = keys.get(chatSlot) ?? chatKey;
    const withoutCost = (ai: ProductSettings["ai"]) => JSON.stringify({ ...ai, model: { ...ai.model, cost: undefined } });
    const aiChanged = withoutCost(settings.ai) !== withoutCost(previous) || nextChatKey !== chatKey;
    // Every chat configuration change is proven to work before it is stored, whatever the client checked.
    if (aiChanged) await this.aiModels.verify({ providerId: settings.ai.providerId, baseUrl: settings.ai.baseUrl,
      key: BASKULE_AI_PROVIDERS[settings.ai.providerId].keyless ? "public" : nextChatKey }, settings.ai.model.id);
    // Only custom endpoints take the admin's prices; built-in models keep the catalog's.
    if (settings.ai.providerId !== "custom") {
      const { cost: _client, ...model } = settings.ai.model;
      const cost = aiChanged ? await this.aiModels.price(settings.ai.providerId, model.id) : previous.model.cost;
      settings.ai = { ...settings.ai, model: cost ? { ...model, cost } : model };
    }
    const reload = aiChanged || JSON.stringify(settings.ai.model.cost) !== JSON.stringify(previous.model.cost);
    this.storage.transactionSync(() => {
      // The check above awaited the provider: refuse if another save replaced the key it proved.
      if (this.savedApiKey(settings.ai.providerId, settings.ai.baseUrl) !== chatKey)
        throw new HttpError(409, "ai_settings_changed", "The AI settings changed meanwhile; check the connection again");
      this.run("insert into kv(key, value) values ('product_settings', ?) on conflict(key) do update set value=excluded.value", JSON.stringify(settings));
      this.run("update organization set name=? where id=?", settings.organizationName, this.orgId);
      for (const [slot, key] of keys)
        this.run("insert into kv(key, value) values (?, ?) on conflict(key) do update set value=excluded.value", slot, key);
    });
    let reloadPending = false;
    if (reload) await Promise.all(this.all("select id from space").map(async row => {
      try {
        const r = await withTimeout(this.callSpace(row.id as string, "/_baskule/reconfigure", { method: "POST" }), REVOKE_TIMEOUT_MS);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await r.body?.cancel();
      } catch { reloadPending = true; console.warn(`Settings saved; space ${row.id} will pick them up on its next boot`); }
    }));
    return json({ ...this.settingsView(), reloadPending });
  }

  private async pluginChange(req: Request, action: Promise<Response>, spaceId?: string): Promise<Response> {
    const response = await action;
    if (req.method === "GET" || !response.ok) return response;
    const spaces = spaceId ? [{ id: spaceId }] : this.all("select id from space");
    await Promise.all(spaces.map(async row => {
      try {
        const r = await withTimeout(this.callSpace(row.id as string, "/_baskule/reconfigure", { method: "POST" }), REVOKE_TIMEOUT_MS);
        await r.body?.cancel();
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch { console.warn(`Plugin settings saved; space ${row.id} will reload on its next boot`); }
    }));
    return response;
  }

  /** First boot: create the admin from ADMIN_EMAIL / ADMIN_PASSWORD when no admin exists. Idempotent. */
  async bootstrapAdmin(): Promise<"created" | "exists" | "missing-config"> {
    if (this.one("select id from user where role = 'admin' limit 1")) return "exists";
    const email = normEmail(this.env.ADMIN_EMAIL);
    const password = this.env.ADMIN_PASSWORD ?? "";
    if (!email || (this.installation.password && !password)) {
      console.warn("ControlCell: no admin yet and ADMIN_EMAIL/ADMIN_PASSWORD are not set");
      return "missing-config";
    }
    await this.auth.api.createUser({ body: { email, ...(this.installation.password ? { password } : {}), name: this.env.ADMIN_NAME || "Admin", role: "admin" } });
    console.log(`ControlCell: bootstrap admin ${email} created`);
    return "created";
  }

  // ---------------------------------------------------------------- hooks
  private async onUserCreated(u: { id: string; name: string; email: string }) {
    this.storage.transactionSync(() => {
      this.run("insert or ignore into user_profile(user_id) values (?)", u.id);
      const id = newId();
      const now = Date.now();
      this.run(
        "insert into space(id, organization_id, kind, name, personal_user_id, created_by, created_at) values (?, ?, 'personal', ?, ?, ?, ?)",
        id, this.orgId, PERSONAL_SPACE_NAME, u.id, u.id, now,
      );
      this.run("insert into space_member(space_id, user_id, role, created_at) values (?, ?, 'owner', ?)", id, u.id, now);
    });
  }

  private async onSessionCreated(s: { id: string; userId: string }) {
    this.run("insert or ignore into user_profile(user_id) values (?)", s.userId);
    this.run("update user_profile set first_sign_in_at = ? where user_id = ? and first_sign_in_at is null", Date.now(), s.userId);
  }

  private async onSessionDeleted(s: { id: string; userId: string }) {
    this.revoke(this.memberSpaceIds(s.userId), { sessionId: s.id });
  }

  // ---------------------------------------------------------------- revocation
  private memberSpaceIds(userId: string): string[] {
    return this.all("select space_id from space_member where user_id = ?", userId).map((r) => r.space_id as string);
  }

  /** Tells each SpaceCell to close matching sockets. Fire now; the current request awaits them before answering. */
  revoke(spaceIds: string[], body: RevokeRequest): void {
    for (const spaceId of spaceIds) {
      this.revocationLog.push({ spaceId, body });
      if (this.revocationLog.length > 500) this.revocationLog.shift();
      const p = withTimeout(
        this.callSpace(spaceId, SPACE_CONTROL.revoke, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.body?.cancel()),
        REVOKE_TIMEOUT_MS,
      ).catch((e) => console.warn(`revoke ${spaceId} failed: ${e}`));
      this.pending.add(p);
      p.finally(() => this.pending.delete(p));
    }
  }

  async flush(): Promise<void> {
    this.usage.prune();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ---------------------------------------------------------------- sessions
  async getSession(headers: Headers): Promise<Session | null> {
    if (this.installation.mode === "anonymous") return {
      user: { id: "anonymous", name: "Anonymous", email: "anonymous@baskule.invalid", role: "admin" },
      session: { id: "anonymous", userId: "anonymous" },
    };
    const s = (await this.auth.api.getSession({ headers })) as Session | null;
    if (!s || s.user.banned) return null;
    return s;
  }

  private async requireSession(req: Request): Promise<Session> {
    const s = await this.getSession(req.headers);
    if (!s) throw new HttpError(401, "unauthenticated");
    return s;
  }

  private async requireAdmin(req: Request): Promise<Session> {
    const s = await this.requireSession(req);
    if (s.user.role !== "admin") throw new HttpError(403, "forbidden", "admin only");
    return s;
  }

  // ---------------------------------------------------------------- request entry
  async handle(req: Request): Promise<Response> {
    let res: Response;
    try {
      // celld peer forwarding can attach an empty body to GET/HEAD requests.
      if (req.method === "GET" || req.method === "HEAD") {
        req = new Request(req.url, {
          method: req.method, headers: req.headers, redirect: req.redirect, body: null,
        });
      }
      if (this.installation.publicOrigin) {
        const url = new URL(this.installation.publicOrigin);
        const incoming = new URL(req.url);
        url.pathname = incoming.pathname;
        url.search = incoming.search;
        req = new Request(url, req);
      }
      res = await this.route(req);
    } catch (e) {
      res = errorResponse(e);
    }
    await this.flush();
    return res;
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const internal = req.headers.get(INTERNAL_HEADER) === "1";
    if (internal && ["/_baskule/usage", "/_baskule/usage/check"].includes(path)) return this.usage.privateRoute(req);
    if (internal && path === "/_baskule/authorize" && req.method === "POST") return this.authorizeRoute(req);
    if (internal && path === "/_baskule/space-exists" && req.method === "POST") {
      const { spaceId } = await readJson<{ spaceId?: string }>(req);
      return json({ exists: !!(typeof spaceId === "string" && this.one("select 1 as x from space where id = ?", spaceId)) });
    }
    if (internal && path === "/_baskule/push/deliver" && req.method === "POST") return this.push.deliver(req);
    if (internal && path === "/_baskule/check" && req.method === "POST") return json(this.check(await readJson<CheckRequest>(req)));
    if (internal && path === "/_baskule/plugin-credential" && req.method === "POST") return pluginCredential(req, this.plugins, this.connections);
    if (internal && path === "/_baskule/settings" && req.method === "POST") {
      const { spaceId } = await readJson<{ spaceId: string }>(req);
      if (!this.spaceRow(spaceId)) return notFound();
      const settings = this.productSettings();
      return json({ ...settings, usageLimits: this.usage.settings(), plugins: this.plugins.settings(spaceId), apiKey: this.one("select value from kv where key=?", this.apiKeySlot(settings.ai.providerId, settings.ai.baseUrl))?.value ?? "" });
    }
    if (path === "/auth" || path.startsWith("/auth/")) return this.authRoute(req, path);
    if (path === WELL_KNOWN_PATH && req.method === "GET") return this.instanceInfo();
    if (path.startsWith("/api/baskule/")) return this.api(req, path.slice("/api/baskule".length), url);
    return notFound();
  }

  /**
   * Public discovery document: a client checks that an address is a Baskule server and learns its name and the
   * login methods it offers (no credentials) before connecting to it.
   */
  private instanceInfo(): Response {
    const org = this.one("select name from organization where id = ?", this.orgId);
    return json({
      product: "baskule",
      name: (org?.name as string | undefined) ?? "Baskule",
      authentication: publicAuthConfig(this.installation),
    }, 200, { "cache-control": "no-store" });
  }

  private async authRoute(req: Request, path: string): Promise<Response> {
    if (this.installation.mode === "anonymous") return path === "/auth/sign-out" ? json({ success: true }) : notFound();
    // Admin actions only go through /api/baskule/admin/* (our checks: no set-password on used accounts, revocation).
    if (path.startsWith("/auth/admin/") || path.startsWith("/auth/sign-up/") ||
      path.startsWith("/auth/sso/")) return notFound();
    if (["/auth/sign-in/social", "/auth/link-social"].includes(path) && req.method === "POST") {
      const input = await req.clone().json().catch(() => null) as { provider?: string; idToken?: unknown } | null;
      // Google/Microsoft connection credentials must come from their server-side code exchange.
      if (input && ["google", "microsoft"].includes(input.provider ?? "") && input.idToken)
        throw new HttpError(400, "provider_code_flow_required");
    }
    const callback = /^\/auth\/callback\/([a-z][a-z0-9-]*)$/.exec(path);
    if (req.method === "POST" && callback && this.installation.providers.some(p => p.id === callback[1])) {
      // Match Better Auth's POST→GET normalization before its same-origin middleware. The GET validates state
      // and restores SameSite=Lax cookies after the IdP's cross-site form submission (e.g. Apple).
      if (!req.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) throw new HttpError(400, "invalid_callback");
      const target = new URL(path, req.url);
      const form = await req.formData();
      for (const key of ["code", "state", "error", "error_description", "user", "iss", "device_id"]) {
        const value = form.get(key);
        if (typeof value === "string") target.searchParams.set(key, value);
      }
      return new Response(null, { status: 302, headers: { location: target.href, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    return this.auth.handler(req);
  }

  // ---------------------------------------------------------------- authorization (Worker → ControlCell)
  async authorize(headers: Headers, spaceId: string): Promise<{ status: 200; identity: Identity } | { status: 401 | 404 }> {
    const s = await this.getSession(headers);
    if (!s) return { status: 401 };
    if (!SPACE_ID_RE.test(spaceId)) return { status: 404 };
    const m = this.one("select role from space_member where space_id = ? and user_id = ?", spaceId, s.user.id);
    if (!m) return { status: 404 };
    return {
      status: 200,
      identity: {
        userId: s.user.id,
        name: s.user.name,
        email: s.user.email,
        role: userRole(s.user.role),
        sessionId: s.session.id,
        spaceRole: m.role as SpaceRole,
      },
    };
  }

  private async authorizeRoute(req: Request): Promise<Response> {
    const { spaceId } = await readJson<{ spaceId?: string }>(req);
    const r = await this.authorize(req.headers, String(spaceId ?? ""));
    return r.status === 200 ? json({ identity: r.identity }) : json({ error: r.status === 401 ? "unauthenticated" : "not_found" }, r.status);
  }

  /** 60 s socket recheck (SpaceCell → ControlCell): which sessions still hold a live session and the membership. */
  check(req: CheckRequest): CheckResponse {
    const now = Date.now();
    const valid: string[] = [];
    if (!req || typeof req.spaceId !== "string" || !Array.isArray(req.sessions)) return { valid };
    for (const s of req.sessions) {
      if (typeof s?.sessionId !== "string" || typeof s?.userId !== "string") continue;
      if (this.installation.mode === "anonymous") {
        if (s.userId === "anonymous" && s.sessionId === "anonymous" && this.memberRole(req.spaceId, "anonymous")) valid.push(s.sessionId);
        continue;
      }
      const ok = this.one(
        `select 1 as x from session se join user u on u.id = se.user_id
         join space_member m on m.user_id = se.user_id and m.space_id = ?
         where se.id = ? and se.user_id = ? and se.expires_at > ? and coalesce(u.banned, 0) = 0`,
        req.spaceId, s.sessionId, s.userId, now,
      );
      if (ok) valid.push(s.sessionId);
    }
    return { valid };
  }

  // ---------------------------------------------------------------- /api/baskule
  private async api(req: Request, p: string, url: URL): Promise<Response> {
    const m = req.method;
    let r: RegExpMatchArray | null;

    if (p === "/push/status" && m === "GET") { await this.requireSession(req); return json(this.push.status()); }
    if ((r = p.match(/^\/push\/devices\/([^/]+)$/)) && ["PUT", "DELETE"].includes(m)) {
      const s = await this.requireSession(req);
      return this.push.device(req, r[1], { userId: s.user.id, sessionId: s.session.id });
    }
    if (p === "/admin/push" && ["GET", "PUT", "PATCH"].includes(m)) { await this.requireAdmin(req); return this.push.settings(req); }
    if (p.startsWith("/native-login")) return this.nativeLogin(req, p, url);
    if (p === "/runtime-settings" && m === "GET") {
      if (!this.env.COMPUTERD_TOKEN || req.headers.get("authorization") !== `Bearer ${this.env.COMPUTERD_TOKEN}`) throw new HttpError(401, "unauthenticated");
      return json({ idleMinutes: this.productSettings().idleMinutes });
    }
    if (this.installation.mode === "anonymous" && p.startsWith("/invitations")) return notFound();

    // Public: invitations (token-authenticated).
    if (p === "/invitations/lookup" && m === "POST") return this.lookupInvitation(req);
    if (p === "/invitations/accept" && m === "POST") return this.acceptInvitation(req);

    if (p === "/usage/me" && m === "GET") return json(this.usage.me((await this.requireSession(req)).user.id));
    if (p === "/transcriptions" && m === "POST") {
      const session = await this.requireSession(req);
      return this.transcribe(req, session.user.id);
    }
    if (p === "/me" && m === "GET") return json(this.me(await this.requireSession(req)));
    if (/^\/plugins\/(?:oauth\/callback|[^/]+\/(?:connect|connection))$/.test(p)) { const s = await this.requireSession(req); return this.connections.user(req, p, s.user, s.session.id); }
    if (p === "/plugins" || p.startsWith("/plugins/")) return this.pluginChange(req, this.plugins.user(req, p, (await this.requireSession(req)).user.id));
    if ((r = p.match(/^\/spaces\/([^/]+)\/plugins$/))) return this.pluginChange(req, this.plugins.space(req, r[1], (await this.requireSession(req)).user), r[1]);
    if (p === "/people" && m === "GET") {
      await this.requireSession(req);
      return json({ people: this.all("select id, name, email from user where coalesce(banned, 0) = 0 order by name") });
    }

    // Spaces
    if (p === "/spaces" && m === "GET") return json({ spaces: this.spacesOf((await this.requireSession(req)).user.id) });
    if (p === "/spaces" && m === "POST") return this.createTeamSpace(req);
    if ((r = p.match(/^\/spaces\/([^/]+)$/))) {
      if (m === "GET") return this.getSpace(req, r[1]);
      if (m === "PATCH") return this.renameSpace(req, r[1]);
      if (m === "DELETE") return this.deleteSpaceRoute(req, r[1]);
    }
    if ((r = p.match(/^\/spaces\/([^/]+)\/members$/)) && m === "POST") return this.addMember(req, r[1]);
    if ((r = p.match(/^\/spaces\/([^/]+)\/members\/([^/]+)$/))) {
      if (m === "PATCH") return this.setMemberRole(req, r[1], r[2]);
      if (m === "DELETE") return this.removeMember(req, r[1], r[2]);
    }

    // Invitations (admin)
    if (p === "/invitations" && m === "POST") return this.createInvitation(req, url);
    if (p === "/invitations" && m === "GET") {
      await this.requireAdmin(req);
      return json({
        invitations: this.all(
          "select id, email, role, spaces, created_at as createdAt, expires_at as expiresAt, accepted_at as acceptedAt, revoked_at as revokedAt from invitation order by created_at desc",
        ).map((i) => ({ ...i, spaces: JSON.parse(i.spaces as string) })),
      });
    }
    if ((r = p.match(/^\/invitations\/([^/]+)$/)) && m === "DELETE") {
      await this.requireAdmin(req);
      this.run("update invitation set revoked_at = ? where id = ? and accepted_at is null", Date.now(), r[1]);
      return json({ ok: true });
    }

    // Admin
    if (p.startsWith("/admin/")) return this.admin(req, p.slice("/admin".length), url);
    return notFound();
  }

  private async transcribe(req: Request, userId: string): Promise<Response> {
    const connection = this.transcriptionConnection();
    if (!connection.voiceInput) throw new HttpError(404, "voice_input_disabled");
    if (this.usage.limits(userId).some(limit => limit.blocked)) throw new HttpError(429, "usage_limit_reached");
    if (this.transcriptions.has(userId) || this.transcriptions.size >= 8) throw new HttpError(429, "too_many_requests");
    const contentType = req.headers.get("content-type") ?? "";
    const mime = contentType.split(";")[0].trim().toLowerCase();
    const extension = AUDIO_EXTENSIONS[mime];
    if (!Object.hasOwn(AUDIO_EXTENSIONS, mime)) throw new HttpError(400, "invalid_audio");
    if (Number(req.headers.get("content-length")) > BASKULE_TRANSCRIPTION_MAX_BYTES) throw new HttpError(413, "audio_too_large");
    if (!req.body) throw new HttpError(400, "invalid_audio");
    this.transcriptions.add(userId);
    // One deadline for the upload and the provider: a stalled body must not hold a slot.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), TRANSCRIPTION_TIMEOUT_MS);
    try {
      let bytes;
      try {
        bytes = await readBounded(req.body, BASKULE_TRANSCRIPTION_MAX_BYTES, new HttpError(413, "audio_too_large"), deadline.signal);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, "invalid_audio");
      }
      if (!bytes.byteLength) throw new HttpError(400, "invalid_audio");
      const form = new FormData();
      form.set("file", new Blob([bytes], { type: contentType }), `audio.${extension}`);
      form.set("model", connection.model);
      form.set("response_format", "json");
      const response = await fetch(`${connection.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
        method: "POST", headers: { authorization: `Bearer ${connection.key}` }, body: form,
        signal: deadline.signal, redirect: "error",
      });
      if (!response.ok) {
        console.warn(`Transcription upstream answered ${response.status}`);
        await response.body?.cancel();
        if ([400, 413, 415].includes(response.status))
          throw new HttpError(400, "invalid_audio", "The provider could not read the recording");
        if (response.status === 429) throw new HttpError(429, "too_many_requests");
        if ([401, 403].includes(response.status))
          throw new HttpError(502, "transcription_key_rejected", "The transcription provider rejected the API key");
        throw new HttpError(502, "transcription_failed", `Transcription provider answered ${response.status}`);
      }
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string")
        throw new HttpError(502, "transcription_failed", "Transcription provider returned no text");
      return json({ text: result.text.trim() });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, "transcription_failed", "Could not transcribe audio");
    } finally {
      clearTimeout(timer);
      this.transcriptions.delete(userId);
    }
  }

  // ---------------------------------------------------------------- me / spaces
  private spacesOf(userId: string) {
    return this.all(
      `select s.id, s.name, s.kind, m.role from space_member m join space s on s.id = m.space_id
       where m.user_id = ? order by case s.kind when 'personal' then 0 else 1 end, s.name`,
      userId,
    ).map((s) => ({ id: s.id as string, name: s.name as string, kind: s.kind as string, role: s.role as SpaceRole, base: spaceBase(s.id as string) }));
  }

  private me(s: Session) {
    const role = userRole(s.user.role);
    const org = this.one("select id, name from organization where id = ?", this.orgId);
    return {
      user: {
        id: s.user.id,
        name: s.user.name,
        email: s.user.email,
        role,
        canCreateSpaces: role === "admin" || this.groups.permissions(s.user.id).canCreateSpaces,
      },
      session: { id: s.session.id },
      organization: org,
      authentication: publicAuthConfig(this.installation),
      voiceInput: this.transcriptionConnection().voiceInput,
      spaces: this.spacesOf(s.user.id),
    };
  }

  private spaceRow(id: string): Row | undefined {
    if (!SPACE_ID_RE.test(id)) return undefined;
    return this.one("select id, name, kind, personal_user_id, created_by, created_at from space where id = ?", id);
  }

  private memberRole(spaceId: string, userId: string): SpaceRole | null {
    return (this.one("select role from space_member where space_id = ? and user_id = ?", spaceId, userId)?.role as SpaceRole) ?? null;
  }

  private members(spaceId: string) {
    return this.all(
      `select u.id as userId, u.name, u.email, m.role from space_member m join user u on u.id = m.user_id
       where m.space_id = ? order by m.role desc, u.name`,
      spaceId,
    );
  }

  /** Team-space management right: space owner or installation admin. Personal spaces: nobody (404 for non-members). */
  private async requireTeamManager(req: Request, spaceId: string): Promise<{ s: Session; space: Row }> {
    const s = await this.requireSession(req);
    const space = this.spaceRow(spaceId);
    const role = space ? this.memberRole(spaceId, s.user.id) : null;
    const isAdmin = s.user.role === "admin";
    if (!space || (!role && !(isAdmin && space.kind === "team"))) throw new HttpError(404, "not_found");
    if (space.kind !== "team") throw new HttpError(409, "personal_space", "personal spaces have exactly one member");
    if (role !== "owner" && !isAdmin) throw new HttpError(403, "forbidden", "space owners only");
    return { s, space };
  }

  private async createTeamSpace(req: Request): Promise<Response> {
    const s = await this.requireSession(req);
    const isAdmin = s.user.role === "admin";
    if (!isAdmin && !this.groups.permissions(s.user.id).canCreateSpaces) throw new HttpError(403, "forbidden", "not allowed to create spaces");
    const body = await readJson<{ name?: string; members?: { userId?: string; email?: string; role?: string }[] }>(req);
    const name = str(body.name, "name", 100);
    const extra = (Array.isArray(body.members) ? body.members : []).map((x) => ({ userId: this.resolveUser(x), role: this.spaceRoleOf(x.role) }));
    const id = newId();
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.run("insert into space(id, organization_id, kind, name, personal_user_id, created_by, created_at) values (?, ?, 'team', ?, null, ?, ?)", id, this.orgId, name, s.user.id, now);
      this.run("insert into space_member(space_id, user_id, role, created_at) values (?, ?, 'owner', ?)", id, s.user.id, now);
      for (const x of extra) this.run("insert or ignore into space_member(space_id, user_id, role, created_at) values (?, ?, ?, ?)", id, x.userId, x.role, now);
    });
    return json({ space: { id, name, kind: "team", role: "owner", base: spaceBase(id) }, members: this.members(id) }, 201);
  }

  private resolveUser(x: { userId?: string; email?: string }): string {
    const row = x?.userId
      ? this.one("select id from user where id = ?", x.userId)
      : this.one("select id from user where email = ?", normEmail(x?.email));
    if (!row) throw new HttpError(404, "user_not_found", `no such user: ${x?.userId ?? x?.email}`);
    return row.id as string;
  }

  private spaceRoleOf(r: unknown): SpaceRole {
    if (r === undefined || r === null || r === "member") return "member";
    if (r === "owner") return "owner";
    throw new HttpError(400, "invalid_role", "role must be owner or member");
  }

  private async getSpace(req: Request, id: string): Promise<Response> {
    const s = await this.requireSession(req);
    const space = this.spaceRow(id);
    const role = space ? this.memberRole(id, s.user.id) : null;
    // Admins may see team spaces' membership (admin panel); personal spaces only to their owner.
    if (!space || (!role && !(s.user.role === "admin" && space.kind === "team"))) return notFound();
    return json({
      space: { id, name: space.name, kind: space.kind, role, base: spaceBase(id), createdAt: space.created_at },
      members: this.members(id),
    });
  }

  private async renameSpace(req: Request, id: string): Promise<Response> {
    await this.requireTeamManager(req, id);
    const name = str((await readJson<{ name?: string }>(req)).name, "name", 100);
    this.run("update space set name = ? where id = ?", name, id);
    return json({ ok: true });
  }

  private async deleteSpaceRoute(req: Request, id: string): Promise<Response> {
    const s = await this.requireSession(req);
    const space = this.spaceRow(id);
    const isAdmin = s.user.role === "admin";
    const role = space ? this.memberRole(id, s.user.id) : null;
    if (!space || (!role && !isAdmin)) return notFound();
    // Personal: admin only (scope: "the admin can only delete it"). Team: owner or admin.
    if (space.kind === "personal" ? !isAdmin : role !== "owner" && !isAdmin) throw new HttpError(403, "forbidden");
    await this.deleteSpace(id);
    if (space.kind === "personal") {
      // Every person has exactly one personal space: deleting it wipes it and starts a fresh one.
      const u = this.one("select id, name, email from user where id = ?", space.personal_user_id);
      if (u) await this.onUserCreated(u as { id: string; name: string; email: string });
    }
    return json({ ok: true });
  }

  /** Wipes the SpaceCell (POST /_baskule/delete) and then removes the rows. Fails closed if the wipe fails. */
  async deleteSpace(id: string): Promise<void> {
    let ok = false;
    try {
      const r = await withTimeout(this.callSpace(id, SPACE_CONTROL.delete, { method: "POST" }), 30_000);
      ok = r.ok;
      await r.body?.cancel();
    } catch (e) {
      console.warn(`delete ${id}: ${e}`);
    }
    if (!ok) throw new HttpError(502, "space_wipe_failed", "the space cell did not confirm the wipe; retry");
    this.storage.transactionSync(() => {
      this.run("delete from space_member where space_id = ?", id);
      this.run("delete from space_runtime where space_id = ?", id);
      this.run("delete from space where id = ?", id);
    });
  }

  private async addMember(req: Request, id: string): Promise<Response> {
    await this.requireTeamManager(req, id);
    const body = await readJson<{ userId?: string; email?: string; role?: string }>(req);
    const userId = this.resolveUser(body);
    const role = this.spaceRoleOf(body.role);
    if (this.memberRole(id, userId)) throw new HttpError(409, "already_member");
    this.run("insert into space_member(space_id, user_id, role, created_at) values (?, ?, ?, ?)", id, userId, role, Date.now());
    return json({ members: this.members(id) }, 201);
  }

  private ownerCount(id: string): number {
    return Number(this.one("select count(*) as n from space_member where space_id = ? and role = 'owner'", id)?.n ?? 0);
  }

  private async setMemberRole(req: Request, id: string, userId: string): Promise<Response> {
    await this.requireTeamManager(req, id);
    const role = this.spaceRoleOf((await readJson<{ role?: string }>(req)).role);
    const cur = this.memberRole(id, userId);
    if (!cur) return notFound();
    if (cur === "owner" && role !== "owner" && this.ownerCount(id) <= 1) throw new HttpError(409, "last_owner", "a team space keeps at least one owner");
    this.run("update space_member set role = ? where space_id = ? and user_id = ?", role, id, userId);
    this.revoke([id], { userId }); // the identity header carries spaceRole: reconnect with the new one
    return json({ members: this.members(id) });
  }

  private async removeMember(req: Request, id: string, userId: string): Promise<Response> {
    const s = await this.requireSession(req);
    const self = userId === s.user.id;
    if (!self) await this.requireTeamManager(req, id);
    const space = this.spaceRow(id);
    const cur = space ? this.memberRole(id, userId) : null;
    if (!space || !cur) return notFound();
    if (space.kind !== "team") throw new HttpError(409, "personal_space");
    if (cur === "owner" && this.ownerCount(id) <= 1) throw new HttpError(409, "last_owner", "a team space keeps at least one owner");
    this.run("delete from space_member where space_id = ? and user_id = ?", id, userId);
    this.revoke([id], { userId });
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- invitations
  /** Native OAuth uses the system browser. Only the initiating app holds the polling secret. */
  private async nativeLogin(req: Request, path: string, url: URL): Promise<Response> {
    if (this.installation.mode === "anonymous") return notFound();
    const now = Date.now();
    if (path === "/native-login/request" && req.method === "POST") {
      if (this.env.AUTH_RATE_LIMIT !== "0") {
        for (const [ip, limit] of this.nativeStarts) if (limit.until <= now) this.nativeStarts.delete(ip);
        const ip = req.headers.get(CLIENT_IP_HEADER) ?? "unknown";
        const limit = this.nativeStarts.get(ip) ?? { until: now + 60_000, count: 0 };
        if (limit.count >= 5 || this.nativeStarts.size >= 1000) throw new HttpError(429, "too_many_requests");
        limit.count++; this.nativeStarts.set(ip, limit);
      }
      this.run("delete from verification where identifier like 'native:%' and expires_at < ?", now);
      if (Number(this.one("select count(*) as n from verification where identifier like 'native:%'")?.n) >= 100) throw new HttpError(429, "too_many_requests");
      const id = randomToken(), secret = randomToken();
      this.run("insert into verification(id, identifier, value, expires_at, created_at, updated_at) values (?, ?, '{}', ?, ?, ?)",
        id, `native:${await sha256Hex(secret)}`, now + 10 * 60_000, now, now);
      return json({ id, secret, url: `${url.origin}/api/baskule/native-login?request=${id}` });
    }
    if (path === "/native-login/poll" && req.method === "POST") {
      const { id, secret } = await readJson<{ id: string; secret: string }>(req);
      if (typeof secret !== "string" || secret.length > 100 || typeof id !== "string") return notFound();
      const row = this.one("select value from verification where id=? and identifier=? and expires_at>?", id, `native:${await sha256Hex(secret)}`, now);
      if (!row) return notFound();
      const { code } = JSON.parse(row.value as string) as { code?: string };
      if (!code) return json({ token: null });
      // The approval is a connect code: redeeming it gives the app its own session and Better Auth's signed bearer.
      this.run("delete from verification where id=?", id);
      const r = await this.auth.api.redeemConnectCode({ body: { code }, headers: req.headers, asResponse: true });
      if (!r.ok) return json({ error: "session_expired" }, 401);
      const bearer = r.headers.get("set-auth-token");
      const headers = new Headers();
      for (const cookie of r.headers.getSetCookie()) headers.append("set-cookie", cookie);
      await r.body?.cancel();
      if (!bearer) throw new HttpError(500, "session_unavailable");
      return json({ token: bearer }, 200, headers);
    }
    if (path !== "/native-login" && path !== "/native-login/approve") return notFound();
    if ((path === "/native-login" && req.method !== "GET") || (path === "/native-login/approve" && req.method !== "POST")) return notFound();
    const session = await this.getSession(req.headers);
    if (!session) return new Response(null, { status: 302, headers: { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` } });
    const id = path.endsWith("/approve") ? (await req.formData()).get("request") : url.searchParams.get("request");
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(id) || !this.one("select id from verification where id=? and identifier like 'native:%' and expires_at>?", id, now)) return notFound();
    if (path.endsWith("/approve")) {
      const { code } = await this.auth.api.createConnectCode({ headers: req.headers });
      this.run("update verification set value=? where id=?", JSON.stringify({ code }), id);
    }
    const approved = path.endsWith("/approve");
    const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baskule · Connect app</title></head><body style="font:16px system-ui;max-width:440px;margin:80px auto;padding:24px"><h1>${approved ? "App connected" : "Connect your app?"}</h1><p>${approved ? "Return to Baskule on your device. You can close this page." : `Connect the app that opened this page as ${esc(session.user.email)}. Continue only if you started this sign-in.`}</p>${approved ? "" : `<form method="POST" action="/api/baskule/native-login/approve"><input type="hidden" name="request" value="${id}"><button type="submit">Connect app</button></form>`}</body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" },
    });
  }

  private async createInvitation(req: Request, url: URL): Promise<Response> {
    const s = await this.requireAdmin(req);
    const body = await readJson<{ email?: string; role?: string; spaces?: { spaceId?: string; role?: string }[]; expiresInHours?: number }>(req);
    const email = normEmail(body.email);
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "invalid_email");
    if (this.one("select id from user where email = ?", email)) throw new HttpError(409, "user_exists", "this person already has an account: add them to spaces directly");
    const role = body.role === "admin" ? "admin" : "member";
    const spaces = (Array.isArray(body.spaces) ? body.spaces : []).map((x) => {
      const sp = this.spaceRow(String(x?.spaceId ?? ""));
      if (!sp || sp.kind !== "team") throw new HttpError(400, "invalid_space", `not a team space: ${x?.spaceId}`);
      return { spaceId: sp.id as string, role: this.spaceRoleOf(x.role) };
    });
    const hours = Math.min(Math.max(Number(body.expiresInHours) || INVITE_DEFAULT_HOURS, 1), 30 * 24);
    const token = randomToken();
    const id = newId();
    const now = Date.now();
    const expiresAt = now + hours * 3600_000;
    this.run(
      "insert into invitation(id, token_hash, email, role, spaces, created_by, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      id, await sha256Hex(token), email, role, JSON.stringify(spaces), s.user.id, now, expiresAt,
    );
    // The token travels in the fragment: never sent to the server by the browser, never in a Referer (review H7).
    return json({ id, email, role, spaces, expiresAt, token, url: `${url.origin}/invite#token=${token}` }, 201);
  }

  private async validInvitation(token: unknown): Promise<Row | undefined> {
    if (typeof token !== "string" || token.length < 20 || token.length > 200) return undefined;
    return this.one(
      "select * from invitation where token_hash = ? and accepted_at is null and revoked_at is null and expires_at > ?",
      await sha256Hex(token), Date.now(),
    );
  }

  private async lookupInvitation(req: Request): Promise<Response> {
    const inv = await this.validInvitation((await readJson<{ token?: string }>(req)).token);
    if (!inv) return json({ error: "invalid_invitation" }, 404, { "referrer-policy": "no-referrer" });
    const spaces = (JSON.parse(inv.spaces as string) as { spaceId: string; role: string }[]).map((x) => ({
      id: x.spaceId, role: x.role, name: this.spaceRow(x.spaceId)?.name ?? null,
    }));
    return json({ email: inv.email, role: inv.role, expiresAt: inv.expires_at, spaces }, 200, { "referrer-policy": "no-referrer" });
  }

  private async acceptInvitation(req: Request): Promise<Response> {
    const body = await readJson<{ token?: string; name?: string; password?: string; email?: string; provider?: string }>(req);
    const external = typeof body.provider === "string" && this.installation.providers.some(p => p.id === body.provider);
    if (body.provider && !external) throw new HttpError(400, "invalid_provider");
    if (!external && !this.installation.password) throw new HttpError(400, "password_disabled");
    const name = str(body.name, "name", 100);
    const password = typeof body.password === "string" ? body.password : "";
    if (!external && (password.length < 8 || password.length > 256)) throw new HttpError(400, "invalid_password", "password: 8 to 256 characters");
    if (typeof body.token !== "string") throw new HttpError(404, "invalid_invitation");
    const hash = await sha256Hex(body.token);
    // Claim atomically: no await between the check and the write (one DO, input gate), so a token is used once.
    const now = Date.now();
    const inv = this.all(
      "update invitation set accepted_at = ? where token_hash = ? and accepted_at is null and revoked_at is null and expires_at > ? returning *",
      now, hash, now,
    )[0];
    if (!inv) throw new HttpError(404, "invalid_invitation");
    const email = inv.email as string;
    const unclaim = () => this.run("update invitation set accepted_at = null where id = ?", inv.id);
    if (body.email !== undefined && normEmail(body.email) !== email) {
      unclaim();
      throw new HttpError(400, "email_mismatch", "the invitation is bound to another email");
    }
    let userId: string;
    try {
      if (this.one("select id from user where email = ?", email)) throw new HttpError(409, "user_exists");
      const created = await this.auth.api.createUser({ body: { email, ...(!external ? { password } : {}), name, role: inv.role as UserRole } });
      userId = created.user.id;
    } catch (e) {
      unclaim();
      throw e;
    }
    const spaces = JSON.parse(inv.spaces as string) as { spaceId: string; role: SpaceRole }[];
    this.storage.transactionSync(() => {
      for (const x of spaces)
        if (this.spaceRow(x.spaceId)?.kind === "team")
          this.run("insert or ignore into space_member(space_id, user_id, role, created_at) values (?, ?, ?, ?)", x.spaceId, userId, x.role, now);
      this.run("update invitation set accepted_user_id = ? where id = ?", userId, inv.id);
    });
    // Provision only: the provider must independently prove the invited identity before any session is issued.
    if (external) return json({ user: { id: userId, email, name } }, 201, { "referrer-policy": "no-referrer" });
    // Sign the new person in: forward Better Auth's cookie and bearer token.
    const signIn = (await this.auth.api.signInEmail({ body: { email, password }, headers: req.headers, asResponse: true })) as Response;
    const headers = new Headers({ "referrer-policy": "no-referrer" });
    for (const c of signIn.headers.getSetCookie?.() ?? []) headers.append("set-cookie", c);
    const bearer = signIn.headers.get("set-auth-token");
    if (bearer) {
      headers.set("set-auth-token", bearer);
      headers.set("access-control-expose-headers", "set-auth-token");
    }
    return json({ user: { id: userId, email, name }, spaces: this.spacesOf(userId), token: bearer }, 201, headers);
  }

  // ---------------------------------------------------------------- admin
  private async admin(req: Request, p: string, url: URL): Promise<Response> {
    const s = await this.requireAdmin(req);
    const m = req.method;
    let r: RegExpMatchArray | null;
    if (p === "/usage" || p.startsWith("/usage/")) return this.usage.adminRoute(req, p, url);
    if (p === "/ai/models" && m === "POST") return json({ models: await this.aiModels.available((await this.connectionCheck(req)).connection) });
    if (p === "/ai/verify" && m === "POST") {
      const { connection, modelId } = await this.connectionCheck(req);
      if (modelId === undefined) throw new HttpError(400, "invalid_connection", "modelId is required");
      await this.aiModels.verify(connection, modelId);
      return json({ ok: true });
    }
    if (p === "/settings" && m === "GET") return json(this.settingsView());
    if ((r = p.match(/^\/plugins\/([^/]+)\/oauth$/))) return this.connections.admin(req, r[1]);
    if (p === "/plugins" || p.startsWith("/plugins/")) return this.pluginChange(req, this.plugins.admin(req, `/admin${p}`));
    if (p === "/groups" || p.startsWith("/groups/")) return this.pluginChange(req, this.groups.handle(req, `/admin${p}`));
    if (p === "/settings" && m === "PATCH") return this.saveSettings(req);
    if (this.installation.mode === "anonymous" && p.startsWith("/users")) return notFound();
    if (p === "/users" && m === "GET") return json({ users: this.listUsers() });
    if (p === "/users" && m === "POST") return this.adminCreateUser(req);
    if ((r = p.match(/^\/users\/([^/]+)$/))) {
      if (m === "PATCH") return this.adminUpdateUser(req, s, r[1]);
      if (m === "DELETE") return this.adminDeleteUser(req, s, r[1]);
    }
    if ((r = p.match(/^\/users\/([^/]+)\/(deactivate|activate|sign-out-everywhere|password|reset-link)$/)) && m === "POST") {
      const userId = r[1];
      if (!this.one("select id from user where id = ?", userId)) return notFound();
      switch (r[2]) {
        case "deactivate":
          if (userId === s.user.id) throw new HttpError(409, "self", "you cannot deactivate yourself");
          await this.auth.api.banUser({ body: { userId, banReason: "deactivated" }, headers: req.headers });
          this.revoke(this.memberSpaceIds(userId), { userId });
          return json({ ok: true });
        case "activate":
          await this.auth.api.unbanUser({ body: { userId }, headers: req.headers });
          return json({ ok: true });
        case "sign-out-everywhere":
          await this.auth.api.revokeUserSessions({ body: { userId }, headers: req.headers });
          this.revoke(this.memberSpaceIds(userId), { userId });
          return json({ ok: true });
        case "password":
          if (!this.installation.password) return notFound();
          return this.setInitialPassword(req, userId);
        case "reset-link":
          if (!this.installation.password) return notFound();
          return this.createResetLink(userId, url);
      }
    }
    if (p === "/spaces" && m === "GET") return this.adminSpaces(url);
    if ((r = p.match(/^\/spaces\/([^/]+)\/stop$/)) && m === "POST") {
      if (!this.spaceRow(r[1])) return notFound();
      return this.stopSpace(r[1]);
    }
    if ((r = p.match(/^\/spaces\/([^/]+)\/status$/)) && m === "GET") {
      if (!this.spaceRow(r[1])) return notFound();
      return json({ status: await this.spaceStatus(r[1]) });
    }
    return notFound();
  }

  private listUsers() {
    const now = Date.now();
    return this.all(
      `select u.id, u.name, u.email, coalesce(u.role, 'member') as role, coalesce(u.banned, 0) as banned, u.created_at as createdAt,
              p.first_sign_in_at as firstSignInAt,
              (select count(*) from session se where se.user_id = u.id and se.expires_at > ?) as activeSessions
       from user u left join user_profile p on p.user_id = u.id order by u.name`,
      now,
    ).map((u): Row => ({ ...u, banned: !!u.banned }));
  }

  private async adminCreateUser(req: Request): Promise<Response> {
    const body = await readJson<{ email?: string; name?: string; password?: string; role?: string }>(req);
    const email = normEmail(body.email);
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "invalid_email");
    const name = str(body.name, "name", 100);
    const password = typeof body.password === "string" ? body.password : "";
    if (!this.installation.password && password) throw new HttpError(400, "password_disabled");
    if (this.installation.password && password.length < 8) throw new HttpError(400, "invalid_password", "temporary password: at least 8 characters");
    if (this.one("select id from user where email = ?", email)) throw new HttpError(409, "user_exists");
    const role: UserRole = body.role === "admin" ? "admin" : "member";
    const created = await this.auth.api.createUser({ body: { email, ...(this.installation.password ? { password } : {}), name, role }, headers: req.headers });
    return json({ user: this.listUsers().find((u) => u.id === created.user.id) }, 201);
  }

  private async adminUpdateUser(req: Request, s: Session, userId: string): Promise<Response> {
    const body = await readJson<{ role?: string; name?: string }>(req);
    const u = this.one("select id, role from user where id = ?", userId);
    if (!u) return notFound();
    if (body.role !== undefined) {
      if (body.role !== "admin" && body.role !== "member") throw new HttpError(400, "invalid_role");
      if (body.role !== "admin" && u.role === "admin" && Number(this.one("select count(*) as n from user where role = 'admin' and coalesce(banned,0) = 0")?.n) <= 1)
        throw new HttpError(409, "last_admin", "keep at least one admin");
      if (body.role !== userRole(u.role)) {
        await this.auth.api.setRole({ body: { userId, role: body.role as UserRole }, headers: req.headers });
        this.revoke(this.memberSpaceIds(userId), { userId }); // identity header carries the role
      }
    }
    if (body.name !== undefined) this.run("update user set name = ?, updated_at = ? where id = ?", str(body.name, "name", 100), Date.now(), userId);
    void s;
    return json({ user: this.listUsers().find((x) => x.id === userId) });
  }

  private async adminDeleteUser(req: Request, s: Session, userId: string): Promise<Response> {
    if (userId === s.user.id) throw new HttpError(409, "self", "you cannot delete yourself");
    if (!this.one("select id from user where id = ?", userId)) return notFound();
    const personal = this.one("select id from space where personal_user_id = ?", userId);
    if (personal) await this.deleteSpace(personal.id as string); // wipe first; fails closed
    this.revoke(this.memberSpaceIds(userId), { userId });
    await this.auth.api.removeUser({ body: { userId }, headers: req.headers });
    this.storage.transactionSync(() => {
      this.run("delete from space_member where user_id = ?", userId);
      this.run("delete from user_profile where user_id = ?", userId);
    });
    return json({ ok: true });
  }

  /** Temporary password, only for an account that has never signed in (review M7: no takeover of a used account). */
  private async setInitialPassword(req: Request, userId: string): Promise<Response> {
    const { password } = await readJson<{ password?: string }>(req);
    if (typeof password !== "string" || password.length < 8 || password.length > 256) throw new HttpError(400, "invalid_password");
    const prof = this.one("select first_sign_in_at from user_profile where user_id = ?", userId);
    if (prof?.first_sign_in_at) throw new HttpError(409, "already_signed_in", "this person has signed in: use a reset link (it signs them out everywhere)");
    const ctx = await this.auth.$context;
    await ctx.internalAdapter.updatePassword(userId, await hashPassword(password));
    return json({ ok: true });
  }

  /** A one-time reset link (no email server). Resetting through it revokes every session of the person
   *  (revokeSessionsOnPasswordReset → session delete hooks → SpaceCell revoke), so a takeover cannot go unnoticed. */
  private async createResetLink(userId: string, url: URL): Promise<Response> {
    const ctx = await this.auth.$context;
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 3600_000);
    await ctx.internalAdapter.createVerificationValue({ value: userId, identifier: `reset-password:${token}`, expiresAt });
    return json({ token, expiresAt: expiresAt.getTime(), url: `${url.origin}/reset-password#token=${token}` }, 201);
  }

  /** Admin "stop": the SpaceCell interrupts runs, stops the computer and goes idle. Allowed for personal spaces too
   *  (it reveals no content). Refreshes the cached status afterwards. */
  private async stopSpace(id: string): Promise<Response> {
    let r: Response;
    try {
      r = await withTimeout(this.callSpace(id, SPACE_CONTROL.stop, { method: "POST" }), 30_000);
    } catch (e) {
      throw new HttpError(502, "stop_failed", String(e));
    }
    const ok = r.ok;
    await r.body?.cancel();
    if (!ok) throw new HttpError(502, "stop_failed", `space answered ${r.status}`);
    return json({ ok: true, status: await this.spaceStatus(id) });
  }

  private async spaceStatus(id: string): Promise<unknown> {
    try {
      const r = await withTimeout(this.callSpace(id, SPACE_CONTROL.status, { method: "GET" }), STATUS_TIMEOUT_MS);
      if (!r.ok) {
        await r.body?.cancel();
        return { error: `status ${r.status}` };
      }
      const st = await r.json();
      this.run("insert or replace into space_runtime(space_id, status, checked_at) values (?, ?, ?)", id, JSON.stringify(st), Date.now());
      return st;
    } catch (e) {
      return { error: String(e) };
    }
  }

  private async adminSpaces(url: URL): Promise<Response> {
    // Cached by default (no cell is woken); ?status=live asks every SpaceCell.
    const live = url.searchParams.get("status") === "live";
    const spaces = this.all(
      `select s.id, s.name, s.kind, s.created_at as createdAt, s.personal_user_id as personalUserId,
              pu.name as ownerName, pu.email as ownerEmail,
              (select count(*) from space_member m where m.space_id = s.id) as memberCount,
              r.status as cachedStatus, r.checked_at as checkedAt
       from space s left join user pu on pu.id = s.personal_user_id left join space_runtime r on r.space_id = s.id
       order by s.kind desc, s.name`,
    );
    const out = await Promise.all(
      spaces.map(async (sp) => ({
        id: sp.id,
        name: sp.name,
        kind: sp.kind,
        createdAt: sp.createdAt,
        memberCount: sp.memberCount,
        // Personal spaces: only the owner is shown, never content (admin can only delete them).
        owner: sp.kind === "personal" ? { userId: sp.personalUserId, name: sp.ownerName, email: sp.ownerEmail } : undefined,
        members: sp.kind === "team" ? this.members(sp.id as string) : undefined,
        status: live ? await this.spaceStatus(sp.id as string) : sp.cachedStatus ? JSON.parse(sp.cachedStatus as string) : null,
        checkedAt: sp.checkedAt ?? null,
      })),
    );
    return json({ spaces: out });
  }
}
