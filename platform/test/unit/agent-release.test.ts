import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { AgentRuntime } from "../../src/agent/index";
import { registerLazyMcp } from "../../src/agent/lazy-mcp";
import { registerSpaceBridge } from "../../src/agent/space-bridge";

const host = vi.hoisted(() => ({ boot: vi.fn() }));
vi.mock("../../src/agent/opencode.js", () => ({ bootOpenCode: host.boot }));

it("releases the real agent's bridge, MCP, key, captures and pending event work", async () => {
  const keysBefore = new Set(Object.keys(process.env));
  let stream!: ReturnType<typeof fs.createWriteStream>;
  let enter!: <A>(run: () => A) => Promise<A>;
  host.boot.mockImplementation(async (options) => {
    enter = options.enter;
    stream = fs.createWriteStream("/capture/release-test");
    stream.write("captured");
    return { close: async () => {}, inBootEvent: options.enter, mcpReady: async () => true, mcpAdd: async () => {} };
  });
  const lifetimes: Promise<unknown>[] = [];
  const runtime = new AgentRuntime({ get: async (key: string) => key === "baskule:workspaceID" ? "fixture" : undefined, getAlarm: async () => null, setAlarm: async () => {} } as never, { AI: null, PLUGINS: { skills: [], servers: [{ pluginId: "fixture", serverId: "fixture", name: "fixture", displayName: "Fixture", listAs: "member" }] } }, "release-test", {},
    { fetch: async () => new Response("bridge") }, promise => { lifetimes.push(promise); });
  const bridge = "http://baskule-space.internal/release-test/mcp";
  const mcps = ["release-test-decision", "release-test-plugin-0", "release-test-t3-code-fixture"].map(key => `http://baskule-mcp.internal/${key}/mcp`);
  try {
    await runtime.boot();
    const added = await runtime.fetch(new Request("http://agent/oc/api/experimental/mcp/t3-code-fixture", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { type: "remote", url: bridge } }),
    }));
    expect(added.status).toBe(204);
    expect(await (await fetch(bridge)).text()).toBe("bridge");
    for (const mcp of mcps) expect((await fetch(mcp)).status).not.toBe(404);
    const keys = Object.keys(process.env).filter(key => !keysBefore.has(key) && key.startsWith("BASKULE_LLM_KEY_"));
    expect(keys).toHaveLength(1);
    const pending = enter(() => { throw new Error("must not enter after release"); });
    runtime.release();
    await expect(pending).rejects.toThrow("OpenCode host is closed");
    await Promise.all(lifetimes);
    expect((await fetch(bridge)).status).toBe(404);
    for (const mcp of mcps) expect((await fetch(mcp)).status).toBe(404);
    expect(process.env[keys[0]!]).toBeUndefined();
    expect(stream.write("late output")).toBe(false);
    await expect(runtime.boot()).rejects.toThrow("Space agent is released");
  } finally { runtime.release(); }
});

it("keeps replacement bridge and MCP registrations when an older owner releases", async () => {
  const oldBridge = registerSpaceBridge("replacement", { fetch: async () => new Response("old") });
  const newBridge = registerSpaceBridge("replacement", { fetch: async () => new Response("new") });
  const handler = async () => new Response("same shared handler");
  const oldMcp = registerLazyMcp("replacement", handler);
  const newMcp = registerLazyMcp("replacement", handler);
  try {
    oldBridge(); oldMcp.unregister();
    expect(await (await fetch("http://baskule-space.internal/replacement/mcp")).text()).toBe("new");
    expect(await (await fetch(newMcp.url)).text()).toBe("same shared handler");
    newBridge(); newMcp.unregister();
    expect((await fetch("http://baskule-space.internal/replacement/mcp")).status).toBe(404);
    expect((await fetch(newMcp.url)).status).toBe(404);
  } finally { oldBridge(); newBridge(); oldMcp.unregister(); newMcp.unregister(); }
});
