import { describe, expect, it } from "vitest";
import worker, { checkOrigin, isControlPath, splitSpacePath, stripBaskuleHeaders } from "../../src/worker";
import { decodeIdentity, encodeIdentity } from "../../src/shared/identity";
import type { Env } from "../../src/env";
import type { Identity } from "../../src/shared/contract";
import { BASKULE_TRANSCRIPTION_MAX_BYTES } from "../../../app/packages/contracts/src/baskule";

const O = "http://os.test";
const ALICE: Identity = { userId: "u_alice", name: "Alice", email: "alice@os.test", role: "member", sessionId: "s_alice", spaceRole: "member" };

function fakeEnv(extra: Partial<Env> = {}) {
  const controlCalls: Request[] = [];
  const spaceCalls: { name: string; req: Request }[] = [];
  const stub = (name: string, handler: (r: Request) => Promise<Response>) => ({ fetch: (r: Request) => handler(r), name });
  const env = {
    PUBLIC_ORIGINS: "http://100.64.0.42:47090",
    CONTROL: {
      getByName: (name: string) =>
        stub(name, async (req) => {
          controlCalls.push(req);
          const url = new URL(req.url);
          if (url.pathname === "/_baskule/authorize") {
            const { spaceId } = (await req.json()) as { spaceId: string };
            const cookie = req.headers.get("cookie") ?? "";
            const bearer = req.headers.get("authorization") ?? "";
            const authed = cookie.includes("baskule.session_token=alice") || bearer === "Bearer alice";
            if (!authed) return Response.json({ error: "unauthenticated" }, { status: 401 });
            if (spaceId !== "acme") return Response.json({ error: "not_found" }, { status: 404 });
            return Response.json({ identity: ALICE });
          }
          if (url.pathname === "/_baskule/space-exists") {
            const { spaceId } = (await req.json()) as { spaceId: string };
            return Response.json({ exists: spaceId === "acme" });
          }
          return Response.json({ control: url.pathname });
        }),
    },
    SPACE: {
      getByName: (name: string) =>
        stub(name, async (req) => {
          spaceCalls.push({ name, req });
          return Response.json({ space: name });
        }),
    },
    ASSETS: {
      fetch: async (req: Request) => {
        const p = new URL(req.url).pathname;
        if (p === "/downloads/index.json") return Response.json({ files: [{ name: "Baskule.AppImage", size: 10, sha256: "ab", modified: "x" }] });
        if (p === "/downloads/Baskule.AppImage") return new Response("BIN");
        return new Response("<html>spa</html>", { headers: { "content-type": "text/html" } });
      },
    },
    ...extra,
  } as unknown as Env;
  return { env, controlCalls, spaceCalls };
}

const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(O + path, init);
const aliceCookie = { cookie: "baskule.session_token=alice.sig; theme=dark" };

describe("identity header", () => {
  it("round-trips base64url JSON with exactly the contract keys", () => {
    const v = encodeIdentity({ ...ALICE, extra: "x" } as Identity);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(v, "base64url").toString())).toEqual(ALICE);
    expect(Object.keys(JSON.parse(Buffer.from(v, "base64url").toString()))).toEqual(["userId", "name", "email", "role", "sessionId", "spaceRole"]);
    expect(decodeIdentity(v)).toEqual(ALICE);
    expect(decodeIdentity("garbage")).toBeNull();
    expect(decodeIdentity(Buffer.from(JSON.stringify({ ...ALICE, role: "root" })).toString("base64url"))).toBeNull();
  });
});

describe("Origin check (review H4)", () => {
  const env = fakeEnv().env;
  const t = (method: string, headers: Record<string, string>) => checkOrigin(req("/s/acme/x", { method, headers }), env)?.status ?? 200;
  it("lets safe methods through", () => expect(t("GET", { origin: "http://evil.test" })).toBe(200));
  it("accepts the request's own origin and PUBLIC_ORIGINS", () => {
    expect(t("POST", { origin: O })).toBe(200);
    expect(t("POST", { origin: "http://100.64.0.42:47090" })).toBe(200);
  });
  it("accepts the configured public origin behind an HTTP proxy", () => {
    const configured = fakeEnv({ AUTH_CONFIG: JSON.stringify({ publicOrigin: "https://public.example.test" }) }).env;
    expect(checkOrigin(req("/auth/sign-in/social", { method: "POST", headers: { origin: "https://public.example.test" } }), configured)).toBeNull();
    expect(checkOrigin(req("/auth/sign-in/social", { method: "POST", headers: { origin: "https://evil.test" } }), configured)?.status).toBe(403);
  });
  it("refuses other origins, other ports of the same host, and null", () => {
    expect(t("POST", { origin: "http://evil.test" })).toBe(403);
    expect(t("POST", { origin: "http://os.test:32400" })).toBe(403);
    expect(t("POST", { origin: "null" })).toBe(403);
    expect(t("DELETE", { origin: "https://os.test" })).toBe(403);
  });
  it("applies to WebSocket upgrades even with GET", () => {
    expect(t("GET", { upgrade: "websocket", origin: "http://evil.test" })).toBe(403);
    expect(t("GET", { upgrade: "websocket", origin: O })).toBe(200);
  });
  it("without Origin: refused with a session cookie, allowed for bearer-only native clients", () => {
    expect(t("POST", aliceCookie)).toBe(403);
    expect(t("GET", { upgrade: "websocket", ...aliceCookie })).toBe(403);
    expect(t("POST", { cookie: "__Secure-baskule.session_token=alice.sig" })).toBe(403);
    expect(t("GET", { upgrade: "websocket", cookie: "__Secure-baskule.session_token=alice.sig" })).toBe(403);
    expect(t("POST", { authorization: "Bearer alice" })).toBe(200);
    expect(t("GET", { upgrade: "websocket", authorization: "Bearer alice" })).toBe(200);
  });
});

describe("path handling", () => {
  it("splits /s/<id>/<rest> and rejects malformed ids", () => {
    expect(splitSpacePath("/s/acme/a/b", "/s/")).toEqual({ spaceId: "acme", rest: "/a/b" });
    expect(splitSpacePath("/s/acme", "/s/")).toEqual({ spaceId: "acme", rest: "/" });
    expect(splitSpacePath("/s/acme//x", "/s/")).toEqual({ spaceId: "acme", rest: "/x" });
    expect(splitSpacePath("/s/", "/s/")).toBeNull();
    expect(splitSpacePath("/s/a%2Fb/x", "/s/")).toBeNull();
    expect(splitSpacePath("/s/a.b/x", "/s/")).toBeNull();
  });
  it("detects every spelling of the internal /_baskule routes", () => {
    for (const p of ["/_baskule/revoke", "/_baskule", "/_Baskule/status", "/%5Fbaskule/delete", "/%255Fbaskule/x", "//_baskule/x", "/%2F_baskule/x", "/\\_baskule/x", "/%E0%A4%A"])
      expect(isControlPath(p), p).toBe(true);
    for (const p of ["/", "/ws", "/api/_baskule", "/_baskulex", "/files/_baskule/x"]) expect(isControlPath(p), p).toBe(false);
  });
  it("strips every inbound x-baskule-* header", () => {
    const h = stripBaskuleHeaders(new Headers({ "X-Baskule-Identity": "x", "x-baskule-base": "y", "x-baskule-internal": "1", accept: "a" }));
    expect([...h.keys()]).toEqual(["accept"]);
  });
});

describe("Worker routing", () => {
  it("forwards a 25 MiB audio body unchanged to the ControlCell stub", async () => {
    const { env, controlCalls } = fakeEnv();
    const bytes = new Uint8Array(BASKULE_TRANSCRIPTION_MAX_BYTES).fill(42);
    bytes[0] = 1;
    bytes[bytes.length - 1] = 255;
    const response = await worker.fetch(req("/api/baskule/transcriptions", {
      method: "POST", body: bytes,
      headers: { origin: O, ...aliceCookie, "content-type": "audio/webm;codecs=opus", "content-length": String(bytes.length) },
    }), env, { waitUntil() {} });
    expect(response.status).toBe(200);
    expect(controlCalls).toHaveLength(1);
    expect(controlCalls[0].headers.get("content-type")).toBe("audio/webm;codecs=opus");
    expect(controlCalls[0].headers.get("content-length")).toBe(String(bytes.length));
    expect(Buffer.from(await controlCalls[0].arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  });

  it("forwards members with the stripped path, fresh identity/base headers and no Better Auth credentials", async () => {
    const { env, spaceCalls } = fakeEnv();
    const res = await worker.fetch(
      req("/s/acme/api/x?q=1", {
        method: "POST",
        body: "hello",
        headers: { ...aliceCookie, cookie: `${aliceCookie.cookie}; __Secure-baskule.session_token=alice.sig`, origin: O, "x-baskule-identity": "forged", "x-baskule-base": "/s/other", "x-baskule-internal": "1", authorization: "Bearer alice" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(spaceCalls).toHaveLength(1);
    const f = spaceCalls[0];
    expect(f.name).toBe("acme");
    expect(new URL(f.req.url).pathname + new URL(f.req.url).search).toBe("/api/x?q=1");
    expect(decodeIdentity(f.req.headers.get("x-baskule-identity"))).toEqual(ALICE);
    expect(f.req.headers.get("x-baskule-base")).toBe("/s/acme");
    expect(f.req.headers.get("x-baskule-internal")).toBeNull();
    expect(f.req.headers.get("authorization")).toBeNull();
    expect(f.req.headers.get("cookie")).toBe("theme=dark");
    expect(await f.req.text()).toBe("hello");
  });

  it("404 for non-members and unknown spaces, 401 without a session; the SpaceCell is never called", async () => {
    const { env, spaceCalls } = fakeEnv();
    expect((await worker.fetch(req("/s/other/x", { headers: aliceCookie }), env)).status).toBe(404);
    expect((await worker.fetch(req("/s/acme/x"), env)).status).toBe(401);
    expect((await worker.fetch(req("/s/acme/_baskule/revoke", { method: "POST", headers: { ...aliceCookie, origin: O } }), env)).status).toBe(404);
    expect((await worker.fetch(req("/s/acme/%5Fbaskule/status", { headers: aliceCookie }), env)).status).toBe(404);
    expect((await worker.fetch(req("/s/acme/x", { headers: { upgrade: "websocket", origin: "http://evil.test", ...aliceCookie } }), env)).status).toBe(403);
    expect(spaceCalls).toHaveLength(0);
  });

  it("checks the session on every request (no caching in the Worker)", async () => {
    const { env, controlCalls } = fakeEnv();
    await worker.fetch(req("/s/acme/a", { headers: aliceCookie }), env);
    await worker.fetch(req("/s/acme/b", { headers: aliceCookie }), env);
    expect(controlCalls.filter((r) => new URL(r.url).pathname === "/_baskule/authorize")).toHaveLength(2);
  });

  it("forwards /auth and /api/baskule to ControlCell with the client IP and without client x-baskule-*", async () => {
    const { env, controlCalls } = fakeEnv();
    await worker.fetch(req("/auth/sign-in/email", { method: "POST", body: "{}", headers: { origin: O, "x-baskule-internal": "1", "x-baskule-client-ip": "6.6.6.6", "x-forwarded-for": "1.2.3.4, 10.0.0.1" } }), env);
    const c = controlCalls[0];
    expect(new URL(c.url).pathname).toBe("/auth/sign-in/email");
    expect(c.headers.get("x-baskule-internal")).toBeNull();
    expect(c.headers.get("x-baskule-client-ip")).toBe("10.0.0.1");
    expect((await worker.fetch(req("/api/baskule/admin/users", { method: "POST", headers: { origin: "http://evil.test", ...aliceCookie } }), env)).status).toBe(403);
    expect((await worker.fetch(req("/api/other"), env)).status).toBe(404);
    expect(await (await worker.fetch(req("/.well-known/baskule"), env)).json()).toEqual({ control: "/.well-known/baskule" });
  });

  it("webhooks: public, existing spaces only, mapped to /api/hooks, no identity", async () => {
    const { env, spaceCalls } = fakeEnv();
    const r = await worker.fetch(req("/hooks/acme/task-1/tok?x=1", { method: "POST", body: "{}", headers: { "x-baskule-identity": "forged", ...aliceCookie } }), env);
    expect(r.status).toBe(200);
    const f = spaceCalls[0].req;
    expect(new URL(f.url).pathname + new URL(f.url).search).toBe("/api/hooks/task-1/tok?x=1");
    expect(f.headers.get("x-baskule-identity")).toBeNull();
    expect(f.headers.get("x-baskule-webhook")).toBe("1");
    expect(f.headers.get("x-baskule-base")).toBe("/s/acme");
    expect(f.headers.get("cookie")).toBe("theme=dark");
    expect((await worker.fetch(req("/hooks/nope/task-1/tok", { method: "POST" }), env)).status).toBe(404);
    expect((await worker.fetch(req("/hooks/acme/_baskule/delete", { method: "POST" }), env)).status).toBe(404);
    expect((await worker.fetch(req("/hooks/acme/x", { headers: { upgrade: "websocket" } }), env)).status).toBe(404);
    expect(spaceCalls).toHaveLength(1);
  });

  it("downloads: manifest, listing, attachment-only files, SPA fallback elsewhere", async () => {
    const { env } = fakeEnv();
    const m = await (await worker.fetch(req("/api/baskule/downloads"), env)).json();
    expect(m).toEqual({ files: [{ name: "Baskule.AppImage", size: 10, sha256: "ab", modified: "x", url: "/downloads/Baskule.AppImage" }] });
    expect(await (await worker.fetch(req("/downloads/"), env)).text()).toContain("Baskule.AppImage");
    const f = await worker.fetch(req("/downloads/Baskule.AppImage"), env);
    expect(f.headers.get("content-disposition")).toContain("attachment");
    expect(await f.text()).toBe("BIN");
    expect((await worker.fetch(req("/downloads/index.html"), env)).status).toBe(404);
    expect(await (await worker.fetch(req("/some/spa/route"), env)).text()).toContain("spa");
  });
});
