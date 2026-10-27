// @effect-diagnostics nodeBuiltinImport:off -- Native transport tests use temporary Node directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Session } from "electron";
import {
  isAppFrame,
  isBaskuleApiPath,
  baskuleConnection,
  parseServerAddress,
} from "./BaskuleConnection.ts";

async function setup() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "baskule-connection-"));
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ product: "baskule" }));
  const get = vi
    .fn()
    .mockResolvedValue([{ name: "baskule.session_token", value: "private-cookie" }]);
  const session = {
    fetch,
    cookies: { get, flushStore: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Pick<Session, "fetch" | "cookies">;
  const connection = await baskuleConnection(directory, session);
  return {
    directory,
    fetch,
    get,
    session,
    connection,
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

describe("Baskule bundled desktop connection", () => {
  it("requires a private network for plain HTTP and rejects URL credentials", () => {
    expect(parseServerAddress("https://cloud.example/link#code=one-time")).toEqual({
      origin: "https://cloud.example",
      code: "one-time",
    });
    expect(
      parseServerAddress("baskule://connect?server=http%3A%2F%2F100.64.0.42%3A47090&code=once"),
    ).toEqual({ origin: "http://100.64.0.42:47090", code: "once" });
    for (const address of [
      "http://public.example",
      "file:///etc/passwd",
      "https://user:secret@cloud.example",
      "baskule://other?server=https://cloud.example",
    ])
      expect(() => parseServerAddress(address)).toThrow();
  });

  it("leaves static assets local and reports an unconfigured API without fetching", async () => {
    await using s = await setup();
    expect(await s.connection.proxy(new Request("baskule://app/assets/app.js"))).toBeNull();
    expect((await s.connection.proxy(new Request("baskule://app/api/baskule/me")))?.status).toBe(
      503,
    );
    expect(s.fetch).not.toHaveBeenCalled();
    expect(isBaskuleApiPath("/s/a/_baskule/wipe")).toBe(false);
  });

  it("discovers and redeems before saving, persists only the origin, and reconnects", async () => {
    await using s = await setup();
    s.fetch
      .mockResolvedValueOnce(Response.json({ product: "baskule" }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await s.connection.connect("https://cloud.example/link#code=once");
    expect(s.fetch.mock.calls[1]?.[0]).toBe("https://cloud.example/auth/connect/redeem");
    expect(s.fetch.mock.calls[1]?.[1]?.body).toBe('{"code":"once"}');
    expect(await NodeFSP.readFile(NodePath.join(s.directory, "baskule-server.json"), "utf8")).toBe(
      '{"origin":"https://cloud.example"}',
    );
    expect((await baskuleConnection(s.directory, s.session)).getOrigin()).toBe(
      "https://cloud.example",
    );
    s.fetch.mockResolvedValueOnce(Response.json({ product: "other" }));
    await expect(s.connection.connect("https://other.example")).rejects.toThrow(
      "not a Baskule server",
    );
    expect(s.connection.getOrigin()).toBe("https://cloud.example");
  });

  it("forwards API bodies and Range, uses native cookies, and hides cookie/token response headers", async () => {
    await using s = await setup();
    await s.connection.connect("https://cloud.example");
    s.fetch.mockResolvedValueOnce(
      new Response("partial", {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "set-cookie": "private",
          "set-auth-token": "private",
          "content-range": "bytes 0-6/10",
        },
      }),
    );
    const response = await s.connection.proxy(
      new Request("baskule://app/s/team/api/assets?id=file", {
        headers: { Range: "bytes=0-6", cookie: "injected", authorization: "injected" },
      }),
    );
    const [url, init] = s.fetch.mock.calls.at(-1)!;
    expect(url).toBe("https://cloud.example/s/team/api/assets?id=file");
    expect(init?.credentials).toBe("include");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("origin")).toBe("https://cloud.example");
    expect(new Headers(init?.headers).get("range")).toBe("bytes=0-6");
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    expect(response?.headers.has("set-cookie")).toBe(false);
    expect(response?.headers.has("set-auth-token")).toBe(false);
    expect(await response?.text()).toBe("partial");
    s.fetch.mockResolvedValueOnce(Response.json({ ok: true }));
    await s.connection.proxy(
      new Request("baskule://app/auth/sign-in/email", {
        method: "POST",
        body: '{"email":"a@b.c"}',
      }),
    );
    expect(new TextDecoder().decode(s.fetch.mock.calls.at(-1)?.[1]?.body as ArrayBuffer)).toBe(
      '{"email":"a@b.c"}',
    );
  });

  it("never executes remote HTML or follows redirects inside the privileged app", async () => {
    await using s = await setup();
    await s.connection.connect("https://cloud.example");
    for (const response of [
      new Response("<script>bad()</script>", { headers: { "content-type": "text/html" } }),
      Response.redirect("https://other.example"),
    ]) {
      s.fetch.mockResolvedValueOnce(response);
      expect((await s.connection.proxy(new Request("baskule://app/api/baskule/me")))?.status).toBe(
        502,
      );
    }
  });

  it("downloads HTML attachments inside a sandbox instead of executing them as app pages", async () => {
    await using s = await setup();
    await s.connection.connect("https://cloud.example");
    s.fetch.mockResolvedValueOnce(
      new Response("<html>report</html>", {
        headers: {
          "content-type": "text/html",
          "content-disposition": 'attachment; filename="report.html"',
        },
      }),
    );
    const response = await s.connection.proxy(
      new Request("baskule://app/s/team/api/assets?id=report"),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-security-policy")).toBe("sandbox allow-downloads");
    expect(response?.headers.get("content-disposition")).toContain("attachment");
    expect(await response?.text()).toBe("<html>report</html>");
  });

  it("attaches cookies only to this app's configured space sockets", async () => {
    await using s = await setup();
    await s.connection.connect("https://cloud.example");
    expect(
      await s.connection.socketHeaders(
        "wss://cloud.example/s/team/ws",
        "baskule://app/",
        "baskule://app",
      ),
    ).toEqual({ Origin: "https://cloud.example", Cookie: "baskule.session_token=private-cookie" });
    expect(
      await s.connection.socketHeaders(
        "wss://cloud.example/s/team/api/preview-stream/ws?threadId=t&tabId=one",
        "baskule://app/",
        "baskule://app",
      ),
    ).toEqual({ Origin: "https://cloud.example", Cookie: "baskule.session_token=private-cookie" });
    for (const [url, frame] of [
      ["wss://other.example/s/team/ws", "baskule://app/"],
      ["wss://cloud.example/s/team/ws", "https://cloud.example/"],
      ["wss://cloud.example/s/team/ws", "baskule://evil/"],
      ["wss://cloud.example/other", "baskule://app/"],
      ["ws://cloud.example/s/team/ws", "baskule://app/"],
      ["wss://other.example/s/team/api/preview-stream/ws", "baskule://app/"],
      ["wss://cloud.example/s/team/api/preview-stream/ws", "https://cloud.example/"],
      ["wss://cloud.example/s/team/api/preview-stream/other", "baskule://app/"],
      ["wss://cloud.example/s/team/api/preview-stream/ws/other", "baskule://app/"],
    ]) {
      expect(await s.connection.socketHeaders(url!, frame!, "baskule://app")).toBeNull();
    }
    expect(s.get).toHaveBeenCalledTimes(2);
    expect(isAppFrame("baskule://app.evil/", "baskule://app")).toBe(false);
  });
});
