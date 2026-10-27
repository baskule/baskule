// Test Worker for the agent runner (test/run.mjs). It reaches the embedded AgentRuntime of the merged SpaceCell the
// way T3 does (the production composition: one cell, one shared SQL client, SpaceCell-owned lifecycle and alarms):
//   /a/<spaceId>/<rest>      →  SpaceCell(<spaceId>) at /_baskule/agent/<rest>   (rest = oc/… or _baskule/…)
//   /space/<spaceId>/<path>  →  SpaceCell(<spaceId>) at /<path> (its own control routes, e.g. /_baskule/delete)
export { SpaceCell } from "../../../space/index";
export { TestControlCell } from "../../../space/test/harness/control-cell";

interface Env {
  SPACE: DurableObjectNamespace;
  CONTROL: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/_test/plain") return new Response("native continuation completed");
    if (url.pathname === "/_test/plugins" || url.pathname.startsWith("/_test/continuation/")) return env.CONTROL.getByName("control").fetch(req);
    const m = /^\/(a|space)\/([A-Za-z0-9_-]{1,64})(\/.*)$/.exec(url.pathname);
    if (!m) return new Response("agent test harness\n");
    const [, kind, spaceId, rest] = m;
    const headers = new Headers(req.headers);
    headers.set("x-baskule-base", `/s/${spaceId}`);
    const path = kind === "a" ? `/_baskule/agent${rest}` : rest!;
    return env.SPACE.getByName(spaceId!).fetch(new Request(new URL(path + url.search, "http://space"), {
      method: req.method, headers, body: req.body, redirect: "manual", signal: req.signal,
    }));
  },
};
