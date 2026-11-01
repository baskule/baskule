import { createServer } from "node:http";

/** @param {{ key?: string; paginate?: boolean }} [options] */
export async function fakeMcp({ key, paginate = false } = {}) {
  const calls = [];
  const state = { onRead: null };
  const tools = [
    { name: "fixture_read", description: "Read the team's notes", inputSchema: { type: "object", properties: {} } },
    { name: "fixture_write", description: "Change the team's notes", inputSchema: { type: "object", properties: {} } },
  ];
  const server = createServer(async (req, res) => {
    const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (key && req.headers.authorization !== key) return json({ error: "unauthorized" }, 401);
    if (req.method !== "POST") return json({}, 405);
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      const reply = result => json({ jsonrpc: "2.0", id: message.id, result });
      if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mcp-editor-fixture", version: "1" } });
      if (message.method === "tools/list") return reply(paginate ? message.params?.cursor ? { tools: tools.slice(1) } : { tools: tools.slice(0, 1), nextCursor: "next" } : { tools });
      if (message.method === "tools/call") {
        calls.push(message.params.name);
        if (message.params.name === "fixture_read") await state.onRead?.();
        return reply({ content: [{ type: "text", text: "The team's notes are ready." }] });
      }
      return reply({});
    } catch { json({ error: "fixture_failure" }, 500); }
  });
  const port = await new Promise(resolve => server.listen(0, "0.0.0.0", () => resolve(server.address().port)));
  return { resource: `http://127.0.0.1:${port}/mcp`, tools, calls, state, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
