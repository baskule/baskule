// Small computerd client used by the integration test and e2e/infra-smoke.sh.
import { WebSocket } from "ws";

export class Client {
  base: string;
  token: string;
  constructor(base: string, token: string) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
  }
  h(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: this.h(headers) };
    if (body !== undefined) {
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) init.body = body as any;
      else {
        init.body = JSON.stringify(body);
        (init.headers as any)["content-type"] = "application/json";
      }
    }
    return fetch(this.base + path, init);
  }
  async json(method: string, path: string, body?: unknown) {
    const r = await this.req(method, path, body);
    const j: any = await r.json();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${j.error}`);
    return j;
  }
  async exec(space: string, body: Record<string, unknown>) {
    const r = await this.req("POST", `/v1/spaces/${space}/exec`, body);
    if (!r.ok) throw new Error(`exec -> ${r.status} ${await r.text()}`);
    const frames = (await r.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    let stdout = "";
    let stderr = "";
    let code: number | null = null;
    let err: string | null = null;
    for (const f of frames) {
      if (f.t === "o") stdout += Buffer.from(f.d, "base64").toString();
      else if (f.t === "e") stderr += Buffer.from(f.d, "base64").toString();
      else if (f.t === "x") code = f.code;
      else if (f.t === "err") err = f.msg;
    }
    return { stdout, stderr, code, err, id: r.headers.get("x-exec-id") };
  }
  ws(path: string): WebSocket {
    return new WebSocket(this.base.replace(/^http/, "ws") + path, { headers: this.h() });
  }
}

/** Open a WS, send messages, collect replies until `until` matches or timeout. */
export function wsExchange(ws: WebSocket, send: string[], until: (msgs: string[]) => boolean, timeoutMs = 30_000) {
  return new Promise<{ msgs: string[]; close?: { code: number; reason: string } }>((resolve, reject) => {
    const msgs: string[] = [];
    const t = setTimeout(() => {
      ws.terminate();
      reject(new Error(`ws timeout; got ${JSON.stringify(msgs).slice(0, 500)}`));
    }, timeoutMs);
    ws.on("unexpected-response", (_q, r) => {
      clearTimeout(t);
      reject(new Error(`ws upgrade refused: ${r.statusCode}`));
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    ws.on("open", () => send.forEach((m) => ws.send(m)));
    ws.on("message", (d) => {
      msgs.push(d.toString());
      if (until(msgs)) {
        clearTimeout(t);
        ws.close();
        resolve({ msgs });
      }
    });
    ws.on("close", (code, reason) => {
      clearTimeout(t);
      resolve({ msgs, close: { code, reason: reason.toString() } });
    });
  });
}
