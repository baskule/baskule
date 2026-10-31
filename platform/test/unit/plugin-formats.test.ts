import { describe, expect, it } from "vitest";
import { addressPlaceholders, parseServersJson, serversJson, skillFieldErrors } from "../../../app/packages/contracts/src/baskule-plugin-formats";

describe("portable plugin formats", () => {
  it.each(["mcpServers", "servers"])("reads %s, lifts secrets and explains local programs", key => {
    const result = parseServersJson(JSON.stringify({ [key]: {
      remote: { url: "https://{tenant}.example.com/${path}", headers: { Authorization: "Bearer private-key", "X-Key": "${input:key}" } },
      local: { command: "npx", args: ["server"] },
      account: { url: "https://example.com/mcp", oauth: {} },
    } }));
    expect(result).toMatchObject({ secrets: { remote: { Authorization: "Bearer private-key" } }, omitted: [{ code: "local_program", subject: "local" }],
      fixes: expect.arrayContaining([{ server: "remote", need: "address", placeholders: ["{tenant}", "${path}"] }, { server: "remote", need: "key", headers: ["Authorization", "X-Key"] }, { server: "account", need: "sign_in" }]) });
    if ("error" in result) throw new Error(result.error);
    const json = serversJson(result.servers);
    expect(json).not.toContain("private-key");
    expect(JSON.parse(json).mcpServers.remote.headers).toEqual({ Authorization: "${AUTHORIZATION}", "X-Key": "${X_KEY}" });
  });
  it("validates addresses and skill fields for the editor and save", () => {
    expect(addressPlaceholders("https://ready.example/mcp")).toEqual([]);
    expect(skillFieldErrors({ name: "Bad Name", description: "" }, [])).toEqual(["name_format", "description_empty"]);
    expect(skillFieldErrors({ name: "good-name", description: "Good" }, ["good-name"])).toEqual(["name_taken"]);
    expect(parseServersJson("[]")).toEqual({ error: "invalid_json" });
  });
});
