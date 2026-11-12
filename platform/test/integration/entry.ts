// Integration-test entry: real Worker and ControlCell, fixture SpaceCell only (no OpenCode/computer).
export { default, ControlCell } from "../../src/worker";
import { EchoSpaceCell } from "../../src/dev/stub-cells";
import { BASE_HEADER, IDENTITY_HEADER, INTERNAL_HEADER } from "../../src/shared/contract";
import { decodeIdentity } from "../../src/shared/identity";
import type { PluginCredential, PluginCredentialRequest } from "../../../app/packages/contracts/src/baskule-plugins";

export class SpaceCell extends EchoSpaceCell {
  override async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== "/_echo/plugin-call") return super.fetch(req);
    const identity = decodeIdentity(req.headers.get(IDENTITY_HEADER));
    const spaceId = req.headers.get(BASE_HEADER)?.slice(3);
    if (!identity || !spaceId) return Response.json({ error: "unavailable" }, { status: 403 });
    const { pluginId, serverId } = await req.json() as { pluginId: string; serverId: string };
    const control = this.env.CONTROL.getByName("control");
    const credential = await control.fetch(new Request("http://control/_baskule/plugin-credential", { method: "POST", headers: { [INTERNAL_HEADER]: "1", "content-type": "application/json" },
      body: JSON.stringify({ spaceId, pluginId, serverId, userId: identity.userId } satisfies PluginCredentialRequest) }));
    const data = await credential.json() as PluginCredential;
    if (!data.ok) return Response.json({ error: data.error });
    // Exercise the private credential seam without ever returning a token to the public client.
    const response = await fetch(data.url, { method: "POST", redirect: "error", headers: { ...data.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read" } }) });
    return Response.json({ status: response.status, result: await response.json() });
  }
}
