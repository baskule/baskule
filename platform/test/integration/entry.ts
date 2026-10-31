// Integration-test entry: real Worker and ControlCell, fixture SpaceCell only (no OpenCode/computer).
export { default, ControlCell } from "../../src/worker";
import { EchoSpaceCell } from "../../src/dev/stub-cells";
import { BASE_HEADER, IDENTITY_HEADER, INTERNAL_HEADER } from "../../src/shared/contract";
import { decodeIdentity } from "../../src/shared/identity";

export class SpaceCell extends EchoSpaceCell {
  override async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== "/_echo/plugin-call") return super.fetch(req);
    const identity = decodeIdentity(req.headers.get(IDENTITY_HEADER));
    const spaceId = req.headers.get(BASE_HEADER)?.slice(3);
    if (!identity || !spaceId) return Response.json({ error: "unavailable" }, { status: 403 });
    const { pluginId, server } = await req.json() as { pluginId: string; server: string };
    const control = this.env.CONTROL.getByName("control");
    const credential = await control.fetch(new Request("http://control/_baskule/plugin-credential", { method: "POST", headers: { [INTERNAL_HEADER]: "1", "content-type": "application/json" }, body: JSON.stringify({ spaceId, pluginId, server, userId: identity.userId }) }));
    const data = await credential.json() as { error?: string; headers?: Record<string, string> };
    if (data.error) return Response.json(data);
    const settings = await control.fetch(new Request("http://control/_baskule/settings", { method: "POST", headers: { [INTERNAL_HEADER]: "1", "content-type": "application/json" }, body: JSON.stringify({ spaceId }) }));
    const target = (await settings.json() as { plugins: { servers: { pluginId: string; name: string; url: string }[] } }).plugins.servers.find(s => s.pluginId === pluginId && s.name === server);
    if (!target) return Response.json({ error: "unavailable" });
    // Exercise the private credential seam without ever returning a token to the public client.
    const response = await fetch(target.url, { method: "POST", redirect: "error", headers: { ...data.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read" } }) });
    return Response.json({ status: response.status, result: await response.json() });
  }
}
