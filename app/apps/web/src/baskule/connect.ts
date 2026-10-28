// baskule: connection links (0.3). A link names the server and carries a one-time code, so a device needs no
// built-in server address: `<origin>/link#code=…` (QR code, paste) and `baskule://connect?server=…&code=…` (the
// desktop app's protocol handler). The code travels in the fragment, so it never reaches a server log.
export function connectLink(origin: string, code: string): string {
  return `${origin}/link#code=${encodeURIComponent(code)}`;
}

export function desktopConnectLink(origin: string, code: string): string {
  return `baskule://connect?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(code)}`;
}

export function codeFromHash(hash: string): string | null {
  const code = new URLSearchParams(hash.replace(/^#/, "")).get("code")?.trim() ?? "";
  return code.length > 0 ? code : null;
}

/** Not inside the desktop app itself (Electron loads the server's pages) and not on a phone or tablet. */
export function canHandOffToDesktopApp(userAgent: string): boolean {
  return !/\bElectron\/|Android|iPhone|iPad|Mobile/i.test(userAgent);
}

export type ConnectionTarget = { readonly origin: string; readonly code: string | null };

function serverOrigin(url: URL): string {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const [first, second] = host.split(".").map(Number);
  const privateHost =
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "::1" ||
    /^f[cd][\da-f]{2}:/.test(host) ||
    (host.split(".").length === 4 &&
      (first === 127 ||
        first === 10 ||
        (first === 192 && second === 168) ||
        (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
        (first === 100 && second !== undefined && second >= 64 && second <= 127)));
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost))
  ) {
    throw new Error("Use HTTPS, or HTTP on a local or private network.");
  }
  return url.origin;
}

/** Accept addresses and one-time links only. Session credentials never belong in a QR. */
export function parseConnectionTarget(value: string): ConnectionTarget {
  const text = value.trim();
  if (!text) throw new Error("Enter a server address or connection link.");
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (url.protocol === "baskule:") {
    if (
      url.hostname !== "connect" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.hash ||
      url.username ||
      url.password ||
      url.port ||
      [...url.searchParams.keys()].some((key) => key !== "server" && key !== "code") ||
      url.searchParams.getAll("server").length !== 1 ||
      url.searchParams.getAll("code").length > 1
    ) {
      throw new Error("Invalid Baskule connection link.");
    }
    const server = new URL(url.searchParams.get("server") ?? "");
    const origin = serverOrigin(server);
    if (server.pathname !== "/" || server.search || server.hash) {
      throw new Error("Use a server address without a path or credentials.");
    }
    return { origin, code: url.searchParams.get("code")?.trim() || null };
  }
  const origin = serverOrigin(url);
  const hash = new URLSearchParams(url.hash.slice(1));
  if (
    url.search ||
    (url.pathname !== "/" && url.pathname !== "/link") ||
    [...hash.keys()].some((key) => key !== "code") ||
    hash.getAll("code").length > 1 ||
    (url.pathname !== "/link" && url.hash)
  ) {
    throw new Error(
      "Use a server address or a Baskule connection link without session credentials.",
    );
  }
  const code = codeFromHash(url.hash);
  if (url.pathname === "/link" && !code) throw new Error("This link has no connection code.");
  return { origin, code };
}

export function connectionTargetLink(target: ConnectionTarget): string {
  return target.code ? connectLink(target.origin, target.code) : target.origin;
}

export function installationOrigin(): string {
  return serverOrigin(
    new URL(window.desktopBridge?.getBaskuleServer?.() ?? window.location.origin),
  );
}
