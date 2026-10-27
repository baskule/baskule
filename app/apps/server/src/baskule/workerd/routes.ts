// baskule: the HTTP routes a space serves (E8, deny by default). The selected features use
// T3's WebSocket RPC plus a few HTTP routes; T3's pairing, OAuth, cloud, pull-request, static,
// device routes are not reachable in a space. Browser streams are authenticated and forwarded
// separately by spaceServer.ts to the computer bridge.

export type RouteDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly status: number; readonly reason: string };

interface Rule {
  readonly methods: ReadonlyArray<string>;
  readonly path: RegExp;
}

const ID = "[A-Za-z0-9._~%:-]+";

const RULES: ReadonlyArray<Rule> = [
  { methods: ["GET", "HEAD"], path: /^\/\.well-known\/t3\/environment$/ },
  { methods: ["GET"], path: /^\/api\/auth\/session$/ },
  { methods: ["POST"], path: /^\/api\/auth\/websocket-ticket$/ },
  // Snapshot bootstrap used by clients before the socket opens.
  { methods: ["GET"], path: /^\/api\/orchestration\/shell$/ },
  {
    methods: ["GET"],
    path: new RegExp(`^/api/orchestration/threads/${ID}(/bounded|/history|/transcript)?$`),
  },
  { methods: ["GET"], path: /^\/api\/projects$/ },
  // Signed asset URLs (files, attachments, downloads) and signed uploads.
  { methods: ["GET", "HEAD"], path: /^\/api\/assets\/.+$/ },
  { methods: ["POST", "PUT"], path: /^\/api\/attachments\/upload\/.+$/ },
  // Webhooks: public through the Worker's /hooks/<spaceId>/…; T3 checks the hook token.
  { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], path: /^\/api\/hooks\/.+$/ },
  // T3's MCP server for its own provider sessions (bearer tokens it mints itself).
  { methods: ["GET", "POST", "DELETE"], path: /^\/mcp$/ },
];

export const classifyRoute = (
  method: string,
  pathname: string,
  isUpgrade: boolean,
): RouteDecision => {
  if (isUpgrade) {
    return pathname === "/ws" && method === "GET"
      ? { allow: true }
      : { allow: false, status: 404, reason: `No WebSocket endpoint at ${pathname} in Baskule.` };
  }
  if (pathname === "/ws")
    return { allow: false, status: 426, reason: "WebSocket upgrade required." };
  for (const rule of RULES) {
    if (rule.path.test(pathname)) {
      return rule.methods.includes(method)
        ? { allow: true }
        : {
            allow: false,
            status: 405,
            reason: `${method} ${pathname} is unsupported in Baskule.`,
          };
    }
  }
  return { allow: false, status: 404, reason: `${pathname} is unsupported in Baskule.` };
};
