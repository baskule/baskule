// Worker `baskule`: the stateless front on every celld node. One origin:
//   /auth/*            → Better Auth (ControlCell)
//   /api/baskule/*    → me, people, spaces, members, invitations, admin (ControlCell)
//   /s/<spaceId>/*     → Origin check + session + membership on EVERY request and upgrade → SpaceCell(<spaceId>)
//   /hooks/<spaceId>/* → public T3 webhooks → SpaceCell(<spaceId>) at /api/hooks/* (T3 checks the hook's own token)
//   /.well-known/baskule → the instance's discovery document (ControlCell)
//   anything else      → the static web bundle (SPA fallback)
import type { Env } from "./env";
import { BASE_HEADER, CLIENT_IP_HEADER, CONTROL_CELL_NAME, INTERNAL_HEADER, IDENTITY_HEADER, BASKULE_HEADER_PREFIX, WEBHOOK_HEADER, WELL_KNOWN_PATH, spaceBase, type Identity } from "./shared/contract";
import { encodeIdentity } from "./shared/identity";
import { SPACE_ID_RE, json, notFound } from "./shared/http";
import { parseAuthConfig } from "./control/auth-config";

export { ControlCell } from "./control/index";
export { SpaceCell } from "./space/index";

const AUTH_COOKIE_PREFIX = /^(?:__Secure-)?baskule\./;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/auth" || p.startsWith("/auth/")) {
        // OAuth form_post callbacks (including Apple) arrive from the IdP. Better Auth verifies their state.
        const callback = /^\/auth\/callback\/([a-z][a-z0-9-]*)$/.exec(p);
        const providerPost = req.method === "POST" && callback && parseAuthConfig(env.AUTH_CONFIG).providers.some(provider => provider.id === callback[1]);
        const o = providerPost ? null : checkOrigin(req, env);
        if (o) return o;
        const r = await control(env).fetch(toControl(req, url));
        if (p !== "/auth/sign-out" || !r.ok) return r;
        // One origin = one browser storage for every user of a profile; wipe it on sign-out
        // (browsers honour this on HTTPS and localhost only; the web client also clears its caches).
        const h = new Headers(r.headers);
        h.set("clear-site-data", '"cache", "storage"');
        return new Response(r.body, { status: r.status, headers: h });
      }
      if (p === WELL_KNOWN_PATH) return await control(env).fetch(toControl(req, url));
      if (p.startsWith("/api/baskule/")) {
        const o = checkOrigin(req, env);
        if (o) return o;
        return await control(env).fetch(toControl(req, url));
      }
      if (p === "/api" || p.startsWith("/api/")) return notFound();
      if (p === "/s" || p.startsWith("/s/")) return await spaceRoute(req, env, url);
      if (p.startsWith("/hooks/")) return await webhookRoute(req, env, url);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error("worker error", e);
      return json({ error: "internal_error" }, 500);
    }
  },
};

const control = (env: Env) => env.CONTROL.getByName(CONTROL_CELL_NAME);

/** Copies headers without any x-baskule-* (clients can never set them). */
export function stripBaskuleHeaders(h: Headers): Headers {
  const out = new Headers();
  h.forEach((v, k) => {
    if (!k.toLowerCase().startsWith(BASKULE_HEADER_PREFIX)) out.append(k, v);
  });
  return out;
}

/** Client address for Better Auth rate limiting: the edge's appended X-Forwarded-For entry, else the peer header. */
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",").map((s) => s.trim()).filter(Boolean).pop() ?? "unknown";
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "unknown";
}

/** Request init that streams the inbound body (`duplex` is required by Node/undici, ignored by workerd). */
function bodyInit(req: Request, headers: Headers): RequestInit {
  const hasBody = !SAFE_METHODS.has(req.method) && req.body !== null;
  return { method: req.method, headers, body: hasBody ? req.body : undefined, redirect: "manual", ...(hasBody ? { duplex: "half" } : {}) } as RequestInit;
}

function toControl(req: Request, url: URL): Request {
  const headers = stripBaskuleHeaders(req.headers);
  headers.set(CLIENT_IP_HEADER, clientIp(req));
  return new Request(url.toString(), bodyInit(req, headers));
}

function hasAuthCookie(h: Headers): boolean {
  return (h.get("cookie") ?? "").split(";").some((c) => AUTH_COOKIE_PREFIX.test(c.trim()));
}

function allowedOrigins(req: Request, env: Env): string[] {
  const publicOrigin = parseAuthConfig(env.AUTH_CONFIG).publicOrigin;
  return [new URL(req.url).origin, ...(publicOrigin ? [publicOrigin] : []), ...(env.PUBLIC_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
}

/**
 * For state-changing methods and WebSocket upgrades, an Origin header must exactly match the request's own
 * origin or one of PUBLIC_ORIGINS ("null" is refused). Without an Origin header the request is only accepted when it
 * carries no session cookie (a native client using a bearer token: no ambient credential, so no CSRF).
 * Returns a 403 response when refused, else null.
 */
export function checkOrigin(req: Request, env: Env): Response | null {
  const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (SAFE_METHODS.has(req.method) && !upgrade) return null;
  const origin = req.headers.get("origin");
  if (origin === null) return hasAuthCookie(req.headers) ? json({ error: "origin_required" }, 403) : null;
  if (allowedOrigins(req, env).includes(origin)) return null;
  return json({ error: "bad_origin" }, 403);
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** True when a forwarded path would address the SpaceCell's internal control routes (/_baskule/*). */
export function isControlPath(rest: string): boolean {
  let d: string | null = rest;
  for (let i = 0; i < 3 && d !== null; i++) {
    const n: string = d.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
    if (n === "/_baskule" || n.startsWith("/_baskule/") || n.startsWith("/_baskule?")) return true;
    const next = safeDecode(d);
    if (next === null) return true; // undecodable: refuse
    if (next === d) break;
    d = next;
  }
  return false;
}

/** Removes the Better Auth cookies and the Authorization header: the SpaceCell only trusts x-baskule-identity. */
function stripCredentials(h: Headers): void {
  h.delete("authorization");
  const cookie = h.get("cookie");
  if (cookie !== null) {
    const kept = cookie.split(";").map((c) => c.trim()).filter((c) => c && !AUTH_COOKIE_PREFIX.test(c));
    if (kept.length) h.set("cookie", kept.join("; "));
    else h.delete("cookie");
  }
}

/** Splits /s/<id>/<rest> (or /hooks/<id>/<rest>). Returns null when malformed. */
export function splitSpacePath(pathname: string, prefix: "/s/" | "/hooks/"): { spaceId: string; rest: string } | null {
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  const i = tail.indexOf("/");
  const spaceId = i < 0 ? tail : tail.slice(0, i);
  if (!SPACE_ID_RE.test(spaceId)) return null;
  const rest = "/" + (i < 0 ? "" : tail.slice(i)).replace(/^\/+/, "");
  return { spaceId, rest };
}

async function authorize(req: Request, env: Env, spaceId: string): Promise<{ identity: Identity } | Response> {
  const h = new Headers({ "content-type": "application/json", [INTERNAL_HEADER]: "1" });
  for (const k of ["cookie", "authorization"]) {
    const v = req.headers.get(k);
    if (v) h.set(k, v);
  }
  const r = await control(env).fetch(new Request("http://control/_baskule/authorize", { method: "POST", headers: h, body: JSON.stringify({ spaceId }) }));
  if (r.status === 200) return (await r.json()) as { identity: Identity };
  await r.body?.cancel();
  return r.status === 401 ? json({ error: "unauthenticated" }, 401) : notFound();
}

async function spaceRoute(req: Request, env: Env, url: URL): Promise<Response> {
  const parts = splitSpacePath(url.pathname, "/s/");
  if (!parts || isControlPath(parts.rest)) return notFound();
  const o = checkOrigin(req, env);
  if (o) return o;
  const a = await authorize(req, env, parts.spaceId);
  if (a instanceof Response) return a;
  const headers = stripBaskuleHeaders(req.headers);
  stripCredentials(headers);
  headers.set(IDENTITY_HEADER, encodeIdentity(a.identity));
  headers.set(BASE_HEADER, spaceBase(parts.spaceId));
  return forward(req, env, parts.spaceId, parts.rest + url.search, url, headers);
}

function forward(req: Request, env: Env, spaceId: string, pathAndQuery: string, url: URL, headers: Headers): Promise<Response> {
  const fwd = new Request(url.origin + pathAndQuery, bodyInit(req, headers));
  return env.SPACE.getByName(spaceId).fetch(fwd);
}

/**
 * Public webhooks: POST/GET/PUT <origin>/hooks/<spaceId>/<hookId>/<token> → SpaceCell `/api/hooks/<hookId>/<token>`.
 * No user session: T3's webhook route checks the hook's own secret token. The space must exist (unknown → 404, and no
 * cell is ever created for an unknown id). WebSocket upgrades are refused. No identity header is set.
 */
async function webhookRoute(req: Request, env: Env, url: URL): Promise<Response> {
  const parts = splitSpacePath(url.pathname, "/hooks/");
  if (!parts || parts.rest === "/" || isControlPath(parts.rest)) return notFound();
  if (req.headers.get("upgrade")) return notFound();
  const r = await control(env).fetch(
    new Request("http://control/_baskule/space-exists", {
      method: "POST",
      headers: { "content-type": "application/json", [INTERNAL_HEADER]: "1" },
      body: JSON.stringify({ spaceId: parts.spaceId }),
    }),
  );
  if (!r.ok || !((await r.json()) as { exists: boolean }).exists) return notFound();
  const headers = stripBaskuleHeaders(req.headers);
  stripCredentials(headers);
  headers.set(BASE_HEADER, spaceBase(parts.spaceId));
  headers.set(WEBHOOK_HEADER, "1");
  return forward(req, env, parts.spaceId, "/api/hooks" + parts.rest + url.search, url, headers);
}
