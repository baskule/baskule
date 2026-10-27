// Test Worker for the SpaceCell runner. It plays the Baskule Worker's forwarding role only:
//   /s/<id>/<rest>      → SpaceCell(<id>) at /<rest>, with x-baskule-base; the test sets
//                         x-baskule-identity itself (the real Worker derives it from the session)
//   /hooks/<id>/<rest>  → SpaceCell(<id>) at /api/hooks/<rest>, no identity
//   /control/<id>/<path>→ SpaceCell(<id>) control endpoints (/_baskule/*)
//   /_test/*            → TestControlCell
export { SpaceCell } from "../../index";
export { TestControlCell } from "./control-cell";

interface Env {
  SPACE: DurableObjectNamespace;
  CONTROL: DurableObjectNamespace;
}

const forward = (env: Env, spaceId: string, path: string, req: Request, identity: boolean) => {
  const headers = new Headers(req.headers);
  headers.set("x-baskule-base", `/s/${spaceId}`);
  if (!identity) headers.delete("x-baskule-identity");
  return env.SPACE.getByName(spaceId).fetch(new Request(new URL(path, "http://space"), { method: req.method, headers, body: req.body, redirect: "manual" }));
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    let m = /^\/s\/([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname);
    if (m) {
      if (m[2]!.startsWith("/_baskule/")) return new Response("not found", { status: 404 });
      return forward(env, m[1]!, m[2]! + url.search, req, true);
    }
    m = /^\/hooks\/([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname);
    if (m) return forward(env, m[1]!, "/api/hooks" + m[2]! + url.search, req, false);
    m = /^\/control\/([A-Za-z0-9_-]+)(\/_baskule\/.*)$/.exec(url.pathname);
    if (m) return forward(env, m[1]!, m[2]! + url.search, req, false);
    if (url.pathname.startsWith("/_test/")) return env.CONTROL.getByName("control").fetch(req);
    return new Response("space test harness\n");
  },
};
