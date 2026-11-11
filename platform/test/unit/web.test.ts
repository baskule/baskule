import { describe, expect, it, vi } from "vitest";
import web from "../../src/web";
import type { WebEnv } from "../../src/env";

const origin = "https://baskule.test";
const req = (path: string, init?: RequestInit) => new Request(origin + path, init);
function fakeEnv(asset?: Response, response = Response.json({ backend: true }, { headers: { "cache-control": "no-store" } })) {
  const backend = vi.fn(async (_request: Request, _init?: RequestInit) => response);
  const assets = vi.fn(async (_request: Request) => asset ?? new Response("<html>spa</html>", { headers: { "content-type": "text/html" } }));
  return { backend, assets, env: { BACKEND: { fetch: backend }, ASSETS: { fetch: assets } } as unknown as WebEnv };
}

describe("Web worker assets", () => {
  it.each(["/", "/some/spa/route", "/hooks", "/authentication", "/apiary"])("serves the SPA for %s", async path => {
    const { env, backend, assets } = fakeEnv();
    const response = await web.fetch(req(path), env);
    expect(await response.text()).toContain("spa");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(assets).toHaveBeenCalledOnce();
    expect(backend).not.toHaveBeenCalled();
  });

  it("serves the running frontend version", async () => {
    const { env } = fakeEnv(Response.json({ version: "0.5.0" }));
    expect(await (await web.fetch(req("/version.json"), env)).json()).toEqual({ version: "0.5.0" });
  });

  it.each(["GET", "HEAD"])("caches successful hashed static assets for %s", async (method) => {
    const { env } = fakeEnv(new Response(method === "HEAD" ? null : "export {}", {
      headers: { "content-type": "text/javascript", "cache-control": "max-age=60" },
    }));
    const response = await web.fetch(req("/assets/index-B_qwZ7m_.js", { method }), env);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe(method === "HEAD" ? "" : "export {}");
  });

  it.each([
    ["/assets/missing-Abcdef12.js", "text/html; charset=utf-8", 200, "GET"],
    ["/assets/missing-Abcdef12.js", "application/xhtml+xml", 200, "GET"],
    ["/assets/missing-Abcdef12.js", "text/javascript", 404, "GET"],
    ["/assets/index.js", "text/javascript", 200, "GET"],
    ["/assets/index-Abcdef12.js", "text/javascript", 200, "POST"],
    ["/version.json", "application/json", 200, "GET"],
  ])("does not cache %s (%s, %i, %s)", async (path, contentType, status, method) => {
    const { env } = fakeEnv(new Response("fallback", {
      status, headers: { "content-type": contentType, "cache-control": "public, max-age=14400" },
    }));
    const response = await web.fetch(req(path, { method }), env);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

});

describe("Web worker backend binding", () => {
  it.each(["/auth", "/auth/get-session", "/api", "/api/baskule/me", "/api/unknown", "/s", "/s/acme/ws", "/hooks/acme/task/token", "/.well-known/baskule"])("forwards %s without an asset fallback", async path => {
    const upstream = Response.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
    const { env, backend, assets } = fakeEnv(undefined, upstream);
    const request = req(path);
    const response = await web.fetch(request, env);
    expect(backend).toHaveBeenCalledExactlyOnceWith(request, { redirect: "manual" });
    expect(response).toBe(upstream);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(assets).not.toHaveBeenCalled();
  });

  it("preserves request URL, headers and streamed body", async () => {
    const { env, backend } = fakeEnv();
    const request = req("/api/baskule/transcriptions?format=json", { method: "POST", body: new Uint8Array([1, 42, 255]),
      headers: { origin, cookie: "baskule.session_token=alice; theme=dark", authorization: "Bearer alice", "content-type": "audio/webm", "x-forwarded-for": "192.0.2.1", "x-baskule-internal": "forged" },
    });
    const body = request.body;
    await web.fetch(request, env);
    const forwarded = backend.mock.calls[0]![0];
    expect(forwarded).toBe(request);
    expect(forwarded.body).toBe(body);
    expect(forwarded.url).toBe(origin + "/api/baskule/transcriptions?format=json");
    expect([...forwarded.headers]).toEqual([...request.headers]);
    expect([...new Uint8Array(await forwarded.arrayBuffer())]).toEqual([1, 42, 255]);
  });

  it("preserves redirects and separate authentication cookies", async () => {
    const headers = new Headers({ location: "/", "cache-control": "no-store", "clear-site-data": '"cache", "storage"' });
    headers.append("set-cookie", "baskule.session_token=alice; Path=/; HttpOnly");
    headers.append("set-cookie", "baskule.session_data=data; Path=/; HttpOnly");
    const upstream = new Response(null, { status: 302, statusText: "Auth redirect", headers });
    const { env, backend } = fakeEnv(undefined, upstream);
    const request = req("/auth/callback/google");
    expect(request.redirect).toBe("follow");
    const response = await web.fetch(request, env);
    expect(backend).toHaveBeenCalledExactlyOnceWith(request, { redirect: "manual" });
    expect(response).toBe(upstream);
    expect(response.statusText).toBe("Auth redirect");
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
    expect(response.headers.get("clear-site-data")).toBe('"cache", "storage"');
  });

  it("returns open streams without reading them", async () => {
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const upstream = new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    const { env } = fakeEnv(undefined, upstream);
    const response = await web.fetch(req("/s/acme/api/events"), env);
    expect(response).toBe(upstream);
    expect(pull).not.toHaveBeenCalled();
    await response.body?.cancel();
  });

  it("returns the native WebSocket upgrade object unchanged", async () => {
    const upgrade = new Response(null);
    Object.defineProperty(upgrade, "status", { value: 101 });
    Object.defineProperty(upgrade, "webSocket", { value: {} });
    const { env, backend } = fakeEnv(undefined, upgrade);
    const request = req("/s/acme/ws", { headers: { upgrade: "websocket", origin, cookie: "baskule.session_token=alice" } });
    expect(await web.fetch(request, env)).toBe(upgrade);
    expect(backend).toHaveBeenCalledExactlyOnceWith(request, { redirect: "manual" });
  });

  it.each(["backend", "assets"])("does not cache unexpected %s failures", async binding => {
    const h = fakeEnv();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    h[binding === "backend" ? "backend" : "assets"].mockRejectedValueOnce(new Error("binding unavailable"));
    try {
      const response = await web.fetch(req(binding === "backend" ? "/api/baskule/me" : "/"), h.env);
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "internal_error" });
    } finally { errorLog.mockRestore(); }
  });
});
