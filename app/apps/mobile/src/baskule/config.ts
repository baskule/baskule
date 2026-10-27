/**
 * Baskule server addresses, connection links and URL helpers (architecture E10).
 *
 * The app signs in to one Baskule server (one organisation) at a time. No server is built in: the person scans or
 * pastes a connection link (`https://<server>/link#code=…`, issued by the web app's "Connect a device"), opens an
 * `baskule://connect?server=…&code=…` link, or types the server's address. The choice is kept on the device.
 */

/** Plain http only where nobody else is on the path: loopback, LAN, Tailscale (100.64.0.0/10), mDNS names. */
export function isPrivateHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost" || name.endsWith(".local") || name === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(name)) return true;
  const match = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(name);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function parseAddress(text: string): URL | null {
  try {
    const url = new URL(HAS_SCHEME.test(text) ? text : `https://${text}`);
    if (!HAS_SCHEME.test(text) && isPrivateHost(url.hostname)) return new URL(`http://${text}`);
    return url;
  } catch {
    return null;
  }
}

/**
 * The server's origin (`https://host[:port]`), or null when the text is not a usable address. A bare address means
 * https, or http on a private network; plain http to a public host is refused.
 */
export function normalizeServerUrl(value: string): string | null {
  const text = value.trim();
  if (text === "") return null;
  const url = parseAddress(text);
  if (url === null || url.hostname === "") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && isPrivateHost(url.hostname)) return url.origin;
  return null;
}

export type ConnectTarget =
  | { readonly kind: "code"; readonly serverUrl: string; readonly code: string }
  | { readonly kind: "invitation"; readonly serverUrl: string; readonly url: string }
  | { readonly kind: "address"; readonly serverUrl: string };

/**
 * Reads what the person scanned, pasted or opened: a connection link (`<server>/link#code=…` or
 * `<scheme>://connect?server=…&code=…`, any of the app variants' schemes), an invitation link
 * (`<server>/invite#token=…`, completed in the browser) or a server address.
 */
export function parseConnectTarget(value: string): ConnectTarget | null {
  const text = value.trim();
  if (/^baskule(?:-dev|-preview)?:\/\/connect(?:[/?#]|$)/i.test(text)) {
    try {
      const url = new URL(text);
      const serverUrl = normalizeServerUrl(url.searchParams.get("server") ?? "");
      const code = url.searchParams.get("code")?.trim() ?? "";
      return serverUrl === null
        ? null
        : code
          ? { kind: "code", serverUrl, code }
          : { kind: "address", serverUrl };
    } catch {
      return null;
    }
  }
  const serverUrl = normalizeServerUrl(text);
  const url = serverUrl === null ? null : parseAddress(text);
  if (serverUrl === null || url === null) return null;
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const code = fragment.get("code")?.trim() ?? "";
  if (url.pathname === "/link" && code) return { kind: "code", serverUrl, code };
  if (url.pathname === "/invite" && fragment.get("token")) {
    return { kind: "invitation", serverUrl, url: url.toString() };
  }
  return { kind: "address", serverUrl };
}

/** `<server>/s/<id>/`: the T3 environment of a space (the `base` field of `/api/baskule/me`). */
export function spaceHttpBaseUrl(serverUrl: string, base: string): string {
  const url = new URL(serverUrl);
  url.pathname = `${base.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function spaceWsBaseUrl(serverUrl: string, base: string): string {
  return spaceHttpBaseUrl(serverUrl, base).replace(/^http/, "ws");
}

/** The connection id of a space's environment registration (one per space and server). */
export function spaceConnectionId(serverUrl: string, spaceId: string): string {
  return `baskule:${new URL(serverUrl).host}:${spaceId}`;
}
