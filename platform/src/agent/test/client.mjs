// Minimal OpenCode HTTP/SSE client for the agent runner (talks to the harness: /a/<spaceId>/oc/... reaches the
// embedded runtime of SpaceCell <spaceId>; /space/<spaceId>/... reaches the SpaceCell itself).
export const HARNESS = process.env.AGENT_HARNESS ?? "http://127.0.0.1:47650";
export const COMPUTERD = process.env.AGENT_COMPUTERD ?? "http://127.0.0.1:47652";
export const COMPUTERD_TOKEN = process.env.AGENT_COMPUTERD_TOKEN ?? "wpd-computerd-token-0123456789";
export const FAKE_LLM = process.env.AGENT_FAKE_LLM ?? "http://127.0.0.1:47651";

export async function http(method, url, body, headers = {}) {
  const init = { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) };
  // One retry on a network error: a pooled keep-alive connection to a restarted celld fails once.
  const r = await fetch(url, init).catch(async () => { await new Promise((ok) => setTimeout(ok, 1000)); return fetch(url, init); }); // no-fixed-sleep-allow: Back off once after a pooled connection fails during restart.
  const t = await r.text();
  let data = null;
  try { data = t ? JSON.parse(t) : null; } catch { data = t; }
  return { status: r.status, data };
}

export const cd = (method, path, body) => http(method, `${COMPUTERD}/v1${path}`, body, { authorization: `Bearer ${COMPUTERD_TOKEN}` });
export async function cdRun(space, argv) {
  const r = await fetch(`${COMPUTERD}/v1/spaces/${space}/exec`, { method: "POST", headers: { authorization: `Bearer ${COMPUTERD_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ argv }) });
  let out = "", code = null;
  for (const l of (await r.text()).split("\n").filter(Boolean)) {
    const f = JSON.parse(l);
    if (f.t === "o" || f.t === "e") out += Buffer.from(f.d, "base64").toString();
    if (f.t === "x") code = f.code;
  }
  return { code, out };
}

export class Agent {
  constructor(space) {
    this.space = space;
    this.base = `${HARNESS}/a/${space}`;
    this.spaceBase = `${HARNESS}/space/${space}`;
  }
  oc(method, path, body) { return http(method, `${this.base}/oc${path}`, body); }
  /** The embedded agent's test routes (/debug/*, BASKULE_AGENT_DEBUG=1). */
  ctl(method, path, body) { return http(method, `${this.base}/_baskule${path}`, body); }
  /** The SpaceCell's own control routes (/stop, /delete, /status). */
  cell(method, path, body) { return http(method, `${this.spaceBase}/_baskule${path}`, body); }
  async createSession(body) {
    const r = await this.oc("POST", "/api/session", body);
    if (r.status !== 200) throw new Error(`session create ${r.status} ${JSON.stringify(r.data)}`);
    return r.data.data;
  }

  /** Sends a prompt and waits for the session's execution to end; returns { outcome, text, tools, events }. */
  async turn(sid, prompt, { timeoutMs = 240_000, onEvent } = {}) {
    const ac = new AbortController();
    const ev = await fetch(`${this.base}/oc/api/event`, { signal: ac.signal });
    const reader = ev.body.getReader();
    const dec = new TextDecoder();
    const res = { outcome: null, text: "", tools: [], events: {}, error: null };
    let resolve;
    const done = new Promise((r) => (resolve = r));
    (async () => {
      let buf = "";
      try {
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            const e = JSON.parse(line.slice(5));
            const s = e.data?.sessionID ?? e.durable?.aggregateID;
            if (s && s !== sid) continue;
            res.events[e.type] = (res.events[e.type] ?? 0) + 1;
            onEvent?.(e);
            if (e.type === "session.text.delta") res.text += e.data.delta;
            else if (e.type === "session.tool.success" || e.type === "session.tool.failed") res.tools.push({ type: e.type, data: e.data });
            else if (/session\.execution\.(succeeded|failed|interrupted)/.test(e.type)) {
              if (e.type.endsWith("failed")) res.error = e.data;
              resolve(e.type.split(".").pop());
            }
          }
        }
      } catch (err) {
        if (err.name !== "AbortError") res.error = String(err);
      }
    })();
    const p = await this.oc("POST", `/api/session/${sid}/prompt`, typeof prompt === "string" ? { text: prompt } : prompt);
    if (p.status !== 200) { ac.abort(); throw new Error(`prompt ${p.status} ${JSON.stringify(p.data)}`); }
    res.outcome = await Promise.race([done, new Promise((r) => setTimeout(() => r("timeout"), timeoutMs))]);
    ac.abort();
    return res;
  }
}
