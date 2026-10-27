// Test harness: a ControlService over the fake storage, with a recording SpaceCell caller.
import { ControlService } from "../../src/control/service";
import { fakeStorage } from "./fake-storage";
import type { Env } from "../../src/env";

export const ORIGIN = "http://os.test";
export const ADMIN = { email: "admin@os.test", password: "admin-password-1" };

export interface SpaceCall {
  spaceId: string;
  path: string;
  method: string;
  body: any;
}

export async function makeService(env: Partial<Env> = {}) {
  const storage = fakeStorage();
  const calls: SpaceCall[] = [];
  let failDelete = false;
  const callSpace = async (spaceId: string, path: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ spaceId, path, method: init?.method ?? "GET", body });
    if (path === "/_baskule/delete" && failDelete) return new Response("no", { status: 500 });
    if (path === "/_baskule/stop" && failDelete) return new Response("no", { status: 500 });
    if (path === "/_baskule/status") return Response.json({ awake: false, sockets: 0, activeRuns: 0, computer: null });
    return Response.json({ ok: true });
  };
  const fullEnv = {
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    AUTH_RATE_LIMIT: "0",
    ...env,
  } as Env;
  const svc = new ControlService(storage, fullEnv, callSpace);
  await svc.init();
  return {
    svc,
    storage,
    calls,
    env: fullEnv,
    setFailDelete: (v: boolean) => (failDelete = v),
    revokes: () => calls.filter((c) => c.path === "/_baskule/revoke"),
  };
}

export type H = Awaited<ReturnType<typeof makeService>>;

export interface Creds {
  cookie?: string;
  bearer?: string;
}

export function request(method: string, path: string, opts: { creds?: Creds; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}): Request {
  const h = new Headers(opts.headers);
  if (opts.creds?.cookie) h.set("cookie", opts.creds.cookie);
  if (opts.creds?.bearer) h.set("authorization", `Bearer ${opts.creds.bearer}`);
  if (opts.origin !== null) h.set("origin", opts.origin ?? ORIGIN);
  if (opts.body !== undefined) h.set("content-type", "application/json");
  return new Request(ORIGIN + path, { method, headers: h, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

export async function call(h: H, method: string, path: string, opts: Parameters<typeof request>[2] = {}) {
  const res = await h.svc.handle(request(method, path, opts));
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

export function cookieFrom(res: { headers: Headers }): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => c.startsWith("baskule.") && !c.endsWith("="))
    .join("; ");
}

export interface SignedIn {
  status: number;
  body?: unknown;
  creds: Creds;
  me: any;
  sessionId: string;
  userId: string;
}

/** Signs in; on failure only `status`/`body` are meaningful. */
export async function signIn(h: H, email: string, password: string): Promise<SignedIn> {
  const r = await call(h, "POST", "/auth/sign-in/email", { body: { email, password } });
  if (r.status !== 200) return { status: r.status, body: r.body, creds: {}, me: null, sessionId: "", userId: "" };
  const creds = { cookie: cookieFrom(r), bearer: r.headers.get("set-auth-token") ?? undefined };
  const me = await call(h, "GET", "/api/baskule/me", { creds: { cookie: creds.cookie } });
  return { status: 200, creds, me: me.body, sessionId: me.body.session.id as string, userId: me.body.user.id as string };
}

export async function asAdmin(h: H) {
  const s = await signIn(h, ADMIN.email, ADMIN.password);
  if (s.status !== 200) throw new Error(`admin sign-in failed: ${JSON.stringify(s.body)}`);
  return s;
}

export async function createUser(h: H, admin: Creds, email: string, name: string, password = "user-password-1", extra: Record<string, unknown> = {}) {
  const r = await call(h, "POST", "/api/baskule/admin/users", { creds: admin, body: { email, name, password, ...extra } });
  if (r.status !== 201) throw new Error(`create user failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.user as { id: string; email: string };
}

export function personalSpaceOf(h: H, userId: string): string {
  return h.storage.sql.exec("select id from space where personal_user_id = ?", userId).toArray()[0].id as string;
}
