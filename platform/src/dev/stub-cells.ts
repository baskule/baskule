// Stub SpaceCell for the Worker integration test (test/integration), which needs a SpaceCell that echoes what the
// Worker forwarded and honours the control contract.
import { DurableObject } from "cloudflare:workers";
import { BASE_HEADER, IDENTITY_HEADER, BASKULE_HEADER_PREFIX, SPACE_CONTROL, type RevokeRequest } from "../shared/contract";
import { decodeIdentity } from "../shared/identity";
import { RECHECK_INTERVAL_MS, recheckSockets, type ControlNamespace } from "../shared/recheck";

interface SocketTag {
  userId: string;
  sessionId: string;
}

export class EchoSpaceCell extends DurableObject<{ CONTROL: ControlNamespace }> {
  /** Reference use of the 60 s recheck: an alarm while sockets are open. */
  private async recheck() {
    const spaceId = (await this.ctx.storage.get<string>("spaceId")) ?? "";
    const sockets = this.ctx.getWebSockets().flatMap((ws) => {
      const t = ws.deserializeAttachment() as SocketTag | null;
      return t ? [{ ...t, close: (c: number, r: string) => ws.close(c, r) }] : [];
    });
    return recheckSockets(this.env.CONTROL, spaceId, sockets);
  }

  async alarm() {
    try { await this.recheck(); } catch (e) { console.warn(`recheck: ${e}`); }
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + RECHECK_INTERVAL_MS);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const base = req.headers.get(BASE_HEADER);
    if (base?.startsWith("/s/") && !(await this.ctx.storage.get("spaceId"))) await this.ctx.storage.put("spaceId", base.slice(3));
    if (url.pathname === "/_echo/recheck") return Response.json(await this.recheck());
    if (url.pathname === SPACE_CONTROL.status) {
      const stops = (await this.ctx.storage.get<number>("stops")) ?? 0;
      return Response.json({ awake: true, sockets: this.ctx.getWebSockets().length, activeRuns: 0, computer: stops ? "stopped" : null, stops });
    }
    if (url.pathname === SPACE_CONTROL.revoke && req.method === "POST") {
      const r = (await req.json()) as RevokeRequest;
      let closed = 0;
      for (const ws of this.ctx.getWebSockets()) {
        const t = ws.deserializeAttachment() as SocketTag | null;
        if (!t) continue;
        if ((r.userId && t.userId === r.userId) || (r.sessionId && t.sessionId === r.sessionId)) {
          try { ws.close(4401, "revoked"); } catch {}
          closed++;
        }
      }
      await this.ctx.storage.put("lastRevoke", r);
      return Response.json({ closed });
    }
    if (url.pathname === SPACE_CONTROL.stop && req.method === "POST") {
      // The stub has no runs or computer: record the stop so tests can observe it.
      await this.ctx.storage.put("stops", ((await this.ctx.storage.get<number>("stops")) ?? 0) + 1);
      return Response.json({ stopped: true });
    }
    if (url.pathname === SPACE_CONTROL.delete && req.method === "POST") {
      for (const ws of this.ctx.getWebSockets()) try { ws.close(4410, "space deleted"); } catch {}
      await this.ctx.storage.deleteAll();
      return Response.json({ deleted: true });
    }
    if (url.pathname === "/_echo/last-revoke") return Response.json((await this.ctx.storage.get("lastRevoke")) ?? null);

    const forwarded: Record<string, string> = {};
    req.headers.forEach((v, k) => { if (k.startsWith(BASKULE_HEADER_PREFIX)) forwarded[k] = v; });
    const identity = decodeIdentity(req.headers.get(IDENTITY_HEADER));
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + RECHECK_INTERVAL_MS);
      if (identity) server.serializeAttachment({ userId: identity.userId, sessionId: identity.sessionId } satisfies SocketTag);
      server.send(JSON.stringify({ hello: true, identity, base: req.headers.get(BASE_HEADER) }));
      return new Response(null, { status: 101, webSocket: client });
    }
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    return Response.json({
      stub: "EchoSpaceCell",
      method: req.method,
      path: url.pathname,
      search: url.search,
      identity,
      baskuleHeaders: forwarded,
      hasAuthorization: req.headers.has("authorization"),
      cookie: req.headers.get("cookie"),
      body,
    });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    ws.send(JSON.stringify({ echo: typeof msg === "string" ? msg : `<${msg.byteLength} bytes>` }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code, reason); } catch {}
  }
}
