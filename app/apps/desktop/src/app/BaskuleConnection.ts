// @effect-diagnostics nodeBuiltinImport:off -- This Electron transport uses native promises and cookie APIs outside Effect.
// baskule: native transport for the bundled T3 renderer. No local HTTP server.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { Session } from "electron";

export function parseServerAddress(value: string): { origin: string; code: string | null } {
  const text = value.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (url.protocol === "baskule:") {
    if (url.hostname !== "connect") throw new Error("Invalid connection link.");
    const target = parseServerAddress(url.searchParams.get("server") ?? "");
    return { ...target, code: url.searchParams.get("code") };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const octets = host.split(".").map(Number);
  const privateHost =
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "::1" ||
    /^f[cd][\da-f]{2}:/.test(host) ||
    (octets.length === 4 &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127)));
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost))
  ) {
    throw new Error("Use HTTPS, or HTTP on a local or private network.");
  }
  return {
    origin: url.origin,
    code: url.pathname === "/link" ? new URLSearchParams(url.hash.slice(1)).get("code") : null,
  };
}

export function isBaskuleApiPath(path: string): boolean {
  return (
    path === "/.well-known/baskule" ||
    path.startsWith("/auth/") ||
    path.startsWith("/api/baskule/") ||
    /^\/s\/[^/]+\/(api\/|\.well-known\/)/.test(path) ||
    path.startsWith("/downloads/")
  );
}

export function isAppFrame(url: string, appOrigin: string): boolean {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}` === appOrigin;
  } catch {
    return false;
  }
}

export async function baskuleConnection(
  stateDir: string,
  session: Pick<Session, "fetch" | "cookies">,
) {
  const settingsPath = NodePath.join(stateDir, "baskule-server.json");
  let origin: string | null = null;
  try {
    const settings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8")) as { origin: string };
    origin = parseServerAddress(settings.origin).origin;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // Electron owns cookies in its private profile. net/session.fetch sends them to
  // the configured server, never to baskule://app, a preview partition, or another host.
  const request = (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.delete("cookie");
    headers.delete("authorization");
    headers.delete("referer");
    headers.set("origin", new URL(url).origin);
    return session.fetch(url, {
      ...init,
      headers,
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  };

  return {
    getOrigin: () => origin,
    async connect(address: string) {
      const target = parseServerAddress(address);
      const discovery = await request(`${target.origin}/.well-known/baskule`);
      const instance = discovery.ok ? ((await discovery.json()) as { product?: string }) : null;
      if (instance?.product !== "baskule")
        throw new Error("This address is not a Baskule server.");
      if (target.code) {
        const redeemed = await request(`${target.origin}/auth/connect/redeem`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: target.code }),
        });
        if (!redeemed.ok)
          throw new Error("The connection link expired or was already used. Create a new one.");
        await redeemed.body?.cancel();
      }
      await NodeFSP.mkdir(stateDir, { recursive: true });
      await NodeFSP.writeFile(`${settingsPath}.tmp`, JSON.stringify({ origin: target.origin }), {
        mode: 0o600,
      });
      await NodeFSP.rename(`${settingsPath}.tmp`, settingsPath);
      await session.cookies.flushStore();
      origin = target.origin;
    },
    async proxy(incoming: Request): Promise<Response | null> {
      const url = new URL(incoming.url);
      if (!isBaskuleApiPath(url.pathname)) return null;
      if (!origin) return Response.json({ error: "server_not_configured" }, { status: 503 });
      const headers = new Headers(incoming.headers);
      for (const key of [...headers.keys()]) {
        if (
          ["host", "content-length", "connection", "accept-encoding"].includes(key) ||
          key.startsWith("sec-")
        )
          headers.delete(key);
      }
      const response = await request(`${origin}${url.pathname}${url.search}`, {
        method: incoming.method,
        headers,
        ...(incoming.method === "GET" || incoming.method === "HEAD"
          ? {}
          : { body: await incoming.arrayBuffer() }),
      });
      // API forwarding must never turn remote HTML into a privileged renderer.
      if (
        (response.headers.get("content-type")?.includes("text/html") &&
          !/^attachment(?:;|$)/i.test(response.headers.get("content-disposition") ?? "")) ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel();
        return Response.json({ error: "unexpected_server_response" }, { status: 502 });
      }
      const outgoing = new Headers(response.headers);
      outgoing.delete("set-cookie");
      outgoing.delete("clear-site-data");
      outgoing.delete("set-auth-token");
      outgoing.set("cache-control", "no-store");
      // Files (including SVG and HTML attachments) must not execute in the app's origin.
      outgoing.set("content-security-policy", "sandbox allow-downloads");
      return new Response(response.body, { status: response.status, headers: outgoing });
    },
    async socketHeaders(
      url: string,
      frameUrl: string,
      appOrigin: string,
    ): Promise<Record<string, string> | null> {
      if (!origin || !isAppFrame(frameUrl, appOrigin)) return null;
      const target = new URL(url);
      const server = new URL(origin);
      if (
        target.protocol !== (server.protocol === "https:" ? "wss:" : "ws:") ||
        target.host !== server.host ||
        !/^\/s\/[^/]+\/(?:ws|api\/preview-stream\/ws)$/.test(target.pathname)
      )
        return null;
      const cookies = await session.cookies.get({ url: `${origin}${target.pathname}` });
      return {
        Origin: origin,
        Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
      };
    },
  };
}
