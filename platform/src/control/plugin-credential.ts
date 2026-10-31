import { z } from "zod";
import type { PluginCredential } from "../../../app/packages/contracts/src/baskule-plugins";
import { json } from "../shared/http";
import type { Plugins } from "./plugins";
import { resolveAccountCredential, type Connections } from "./connections";

const input = z.object({ spaceId: z.string().min(1).max(200), pluginId: z.string().min(1).max(200), server: z.string().min(1).max(200), userId: z.string().min(1).max(200) }).strict();

/** Private channel only. Policy is rechecked even when the caller has a cached credential. */
export async function pluginCredential(req: Request, plugins: Plugins, connections: Connections): Promise<Response> {
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_plugin_input" }, 400);
  const { spaceId, pluginId, server, userId } = parsed.data;
  const decision = plugins.canUse(userId, spaceId, pluginId, server);
  if (!decision.allowed) return json({ error: decision.error } satisfies PluginCredential);
  const target = plugins.get(pluginId)!.servers.find(s => s.name === server)!;
  const expiresAt = Date.now() + 60_000;
  switch (target.credential) {
    case "none": return json({ headers: {}, expiresAt } satisfies PluginCredential);
    case "organization": {
      const headers = await plugins.organizationHeaders(pluginId, server);
      const current = plugins.canUse(userId, spaceId, pluginId, server);
      if (!current.allowed) return json({ error: current.error });
      return json(headers ? { headers, expiresAt } : { error: "needs_connection", connectUrl: "/admin/plugins" });
    }
    case "user-oauth":
    case "login-identity": {
      const credential = await resolveAccountCredential(connections, parsed.data);
      return json("headers" in credential ? { ...credential, expiresAt } satisfies PluginCredential : credential);
    }
  }
}
