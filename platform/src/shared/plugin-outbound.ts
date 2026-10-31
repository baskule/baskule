import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { PluginServer } from "../../../app/packages/contracts/src/baskule-plugins";
import { HttpError } from "./http";

export type Network = "public" | "private";

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    const parts = host.slice(1, -1).split("::");
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts[1] ? parts[1].split(":") : [];
    const words = [...left, ...Array(parts.length === 2 ? 8 - left.length - right.length : 0).fill("0"), ...right].map(v => parseInt(v, 16));
    if (words.slice(0, 5).every(v => v === 0) && words[5] === 0xffff)
      return isPrivateHost(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    return words.slice(0, 7).every(v => v === 0) || (words[0] & 0xfe00) === 0xfc00 ||
      (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00 || words[0] === 0x2001 && words[1] === 0xdb8;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113;
  }
  return !host.includes(".") || host === "localhost" || /\.(localhost|local|internal)$/.test(host);
}

// URL checks cannot see public DNS names resolving to private IPs; deployment egress must block those.
export function checkOutbound(value: string | URL, network: Network): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "address_not_allowed"); }
  const privateHost = isPrivateHost(url.hostname);
  if (url.hostname.toLowerCase().replace(/\.$/, "") === "baskule-mcp.internal" || url.username || url.password || url.hash ||
      /[{}$]/.test(url.href) || !(url.protocol === "https:" || url.protocol === "http:" && network === "private" && privateHost) ||
      network === "public" && privateHost) throw new HttpError(400, "address_not_allowed");
  return url;
}

export async function connectMcp(server: Pick<PluginServer, "url" | "transport">, network: Network, headers: Record<string, string>, timeoutMs: number): Promise<Client> {
  const url = checkOutbound(server.url, network);
  const client = new Client({ name: "baskule-plugin-proxy", version: "0.4.0" }, { capabilities: {} });
  const options = { requestInit: { headers }, fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const target = checkOutbound(input instanceof Request ? input.url : String(input), network);
    if (target.origin !== url.origin) throw new HttpError(400, "address_not_allowed");
    return fetch(input, { ...init, redirect: "error" });
  } };
  const transport = server.transport === "sse" ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
  try { await client.connect(transport, { timeout: timeoutMs }); return client; }
  catch (error) { await client.close().catch(() => {}); throw error; }
}
