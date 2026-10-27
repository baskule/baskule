// Minimal T3 WebSocket RPC client (Effect RPC JSON frames) for the SpaceCell tests.
export const ORCHESTRATION_PROTOCOL = 2;

export const identityHeader = (identity) => Buffer.from(JSON.stringify(identity)).toString("base64url");

export class RpcClient {
  /** Opens `ws://…/s/<space>/ws`; rejects with the HTTP status when the upgrade is refused. */
  static open(baseUrl, spaceId, identity, extraQuery = "") {
    const url = `${baseUrl.replace(/^http/, "ws")}/s/${spaceId}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL}${extraQuery}`;
    const headers = identity ? { "x-baskule-identity": typeof identity === "string" ? identity : identityHeader(identity) } : {};
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const client = new RpcClient(ws);
      ws.onopen = () => resolve(client);
      ws.onerror = (e) => reject(new Error(`upgrade refused: ${e.message ?? "error"}`));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.streams = new Map();
    this.closed = new Promise((resolve) => {
      ws.onclose = (e) => {
        for (const p of this.pending.values()) p({ _tag: "Closed", code: e.code });
        resolve({ code: e.code, reason: e.reason });
      };
    });
    ws.onmessage = (e) => {
      for (const line of String(e.data).split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        for (const x of Array.isArray(m) ? m : [m]) this.onFrame(x);
      }
    };
  }

  onFrame(x) {
    if (x._tag === "Ping") return this.send({ _tag: "Pong" });
    if (x._tag === "Exit") {
      const p = this.pending.get(x.requestId);
      if (p) {
        this.pending.delete(x.requestId);
        p(x.exit);
      }
      const s = this.streams.get(x.requestId);
      if (s) s.onExit?.(x.exit);
      return;
    }
    if (x._tag === "Chunk") {
      const s = this.streams.get(x.requestId);
      if (s) for (const v of x.values) s.onValue(v);
      this.send({ _tag: "Ack", requestId: x.requestId });
    }
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  /** A request RPC; resolves with T3's Exit (`{_tag: "Success", value}` or `{_tag: "Failure", cause}`). */
  call(tag, payload = {}, timeoutMs = 30_000) {
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${tag} timed out`));
      }, timeoutMs);
      this.pending.set(id, (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  async ok(tag, payload) {
    const exit = await this.call(tag, payload);
    if (exit?._tag !== "Success") throw new Error(`${tag} failed: ${JSON.stringify(exit)}`);
    return exit.value;
  }

  /** A streaming RPC; `onValue` gets each element. Returns an unsubscribe function. */
  stream(tag, payload, onValue, onExit) {
    const id = String(++this.nextId);
    this.streams.set(id, { onValue, onExit });
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    return () => {
      this.streams.delete(id);
      this.send({ _tag: "Interrupt", requestId: id });
    };
  }

  close() {
    this.ws.close();
  }
}

/** Resolves when `predicate` returns a truthy value (polled), or rejects after `timeoutMs`. */
export const waitFor = async (what, predicate, timeoutMs = 30_000, everyMs = 100) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs)); // no-fixed-sleep-allow: Poll the predicate until the deadline.
  }
};
