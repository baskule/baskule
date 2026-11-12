import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyIndexed, classifyPluginFiles, collectMcpServers, parseGithubUrl, parsePluginDirectory, type RepoFile } from "../../src/control/plugins/package";

const fixture = (path: string) => readFileSync(new URL(`../fixtures/marketplace/${path}`, import.meta.url), "utf8");
const vendored = (name: string): RepoFile[] => [
  { path: ".cursor-plugin/plugin.json", content: fixture(`cursor/${name}/plugin.json`) },
  { path: "mcp.json", content: fixture(`cursor/${name}/mcp.json`) },
  { path: "assets/logo.svg", content: "" },
  { path: "README.md", content: "" },
];
const decode = (base64: string) => Buffer.from(base64, "base64").toString("utf8");

describe("plugin packages", () => {
  it("turns ${VAR} placeholders into variables the administrator fills in", async () => {
    const netsuite = await parsePluginDirectory(vendored("netsuite"), "netsuite");
    expect(netsuite).toMatchObject({ name: "netsuite", displayName: "NetSuite", logo: "assets/logo.png", category: "integrations", skipped: [] });
    expect(netsuite.servers).toEqual([{ name: "netsuite", url: "${NETSUITE_MCP_URL}", transport: "streamable-http", headers: {},
      variables: [{ name: "NETSUITE_MCP_URL", description: expect.stringContaining("Account-specific AI Connector Service URL"), secret: false, where: "url" }] }]);
    const github = await parsePluginDirectory(vendored("github"), "github");
    expect(github.servers[0]).toEqual({ name: "github", url: "https://api.githubcopilot.com/mcp/", transport: "streamable-http",
      headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" },
      variables: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", description: expect.stringContaining("Fine-grained or classic PAT"), secret: true, where: "header" }] });
    const gmail = await parsePluginDirectory(vendored("gmail"), "gmail");
    expect(gmail.servers).toEqual([{ name: "gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", transport: "streamable-http", headers: {}, variables: [] }]);
    expect(gmail.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(collectMcpServers({ mcpServers: { shared: { url: "${ADDRESS}", headers: { Authorization: "${ADDRESS}" } } } }).servers[0]!.variables)
      .toEqual([{ name: "ADDRESS", secret: true, where: "url" }]);
    expect((await parsePluginDirectory([...vendored("gmail"), { path: "docs/x.md", content: "" }], "gmail")).digest).not.toBe(gmail.digest);
  });

  it("skips local programs, editor-only parts and vendor-only servers, and reports them", () => {
    const { servers, skipped } = collectMcpServers({ mcpServers: {
      local: { command: "npx", args: ["server"] },
      ws: { type: "websocket", url: "wss://vendor.test" },
      cursor: { type: "http", url: "https://api.cursor.com/mcp" },
      branded: { type: "http", url: "https://vendor.test/mcp", headers: { "x-cursor-token": "1" } },
      relay: { type: "http", url: "https://vendor.test/mcp", auth: { CLIENT_ID: "x" } },
      plain: { type: "http", url: "http://vendor.test/mcp" },
      query: { type: "http", url: "https://vendor.test/mcp?key=${KEY}" },
      broken: { type: "http", url: "https://vendor.test/${BROKEN" },
      host: { type: "sse", url: "https://${TENANT}.vendor.test/sse" },
    } });
    expect(servers.map(s => [s.name, s.transport, s.variables.map(v => v.name)])).toEqual([["host", "sse", ["TENANT"]]]);
    expect(skipped).toEqual([
      { kind: "local_program", subject: "local" }, { kind: "unsupported_transport", subject: "ws" }, { kind: "editor_only", subject: "cursor" },
      { kind: "editor_only", subject: "branded" }, { kind: "editor_only", subject: "relay" }, { kind: "invalid_server", subject: "plain" },
      { kind: "invalid_server", subject: "query" }, { kind: "invalid_server", subject: "broken" },
    ]);
  });

  it("collects skills, agents and commands as skills with canonical front matter", async () => {
    const parsed = await parsePluginDirectory([
      { path: "plugin.json", content: JSON.stringify({ name: "notes", description: "Team notes" }) },
      { path: "skills/summarize/SKILL.md", content: "---\nname: summarize\ndescription: 'Summarize: briefly'\nlicense: MIT\n---\nKeep it short." },
      { path: "skills/summarize/reference.md", content: "Reference" },
      { path: "skills/runner/SKILL.md", content: "---\nname: runner\ndescription: Runs\n---\nRun." },
      { path: "skills/runner/run.sh", content: "" },
      { path: "skills/broken/SKILL.md", content: "No front matter" },
      { path: "agents/reviewer.md", content: "---\nname: reviewer\ndescription: Reviews drafts\n---\nReview carefully." },
      { path: "commands/standup.md", content: "# Write the standup\nUse $ARGUMENTS." },
      { path: "commands/_shared.md", content: "Shared" },
      { path: "hooks/hooks.json", content: "" },
    ], "fallback");
    expect(parsed.skills.map(s => [s.name, s.description, s.files.map(f => f.path)])).toEqual([
      ["reviewer", "Reviews drafts", ["reviewer/SKILL.md"]],
      ["standup", "Write the standup", ["standup/SKILL.md"]],
      ["summarize", "Summarize: briefly", ["summarize/SKILL.md", "summarize/reference.md"]],
    ]);
    expect(decode(parsed.skills[2]!.files[0]!.base64)).toBe('---\nname: "summarize"\ndescription: "Summarize: briefly"\nlicense: MIT\n---\nKeep it short.');
    expect(decode(parsed.skills[1]!.files[0]!.base64)).toContain("$ARGUMENTS is whatever the user wrote after /standup.");
    expect(parsed.skipped).toEqual([{ kind: "editor_only", subject: "hooks/" }, { kind: "invalid_skill", subject: "runner" }, { kind: "invalid_skill", subject: "skills/broken/SKILL.md" }]);
    await expect(parsePluginDirectory([{ path: "README.md", content: "" }], "empty")).rejects.toMatchObject({ code: "plugin_empty" });
    expect((await parsePluginDirectory([{ path: "SKILL.md", content: "---\nname: Brand Voice\ndescription: Write in our voice\n---\nWrite." }], "Brand voice"))).toMatchObject({ name: "brand-voice", displayName: "Brand Voice" });
  });

  it("decides browse completeness from the file list like an install would", () => {
    const sizes = new Map<string, number>();
    const mcp = fixture("cursor/netsuite/mcp.json");
    expect(classifyPluginFiles([".cursor-plugin/plugin.json", "mcp.json"], mcp, sizes)).toEqual({ hasServers: true, skillCount: 0 });
    expect(classifyPluginFiles([".cursor-plugin/plugin.json", "mcp.json"], undefined, sizes)).toBeNull();
    expect(classifyPluginFiles(["skills/a/SKILL.md", "hooks/hooks.json"], undefined, sizes)).toBe("incomplete");
    expect(classifyPluginFiles(["skills/a/SKILL.md", "skills/a/run.py"], undefined, sizes)).toBe("incomplete");
    expect(classifyPluginFiles(["skills/a/SKILL.md", "agents/b.md", "commands/c.md", "commands/_d.md"], undefined, sizes)).toEqual({ hasServers: false, skillCount: 3 });
    expect(classifyPluginFiles(["mcp.json"], JSON.stringify({ mcpServers: { local: { command: "x" } } }), sizes)).toBe("incomplete");
    expect(classifyIndexed({ mcpServers: [{ description: "http" }], skills: [{}, {}] })).toEqual({ hasServers: true, skillCount: 2 });
    expect(classifyIndexed({ mcpServers: [{ description: "stdio" }] })).toBeNull();
    expect(classifyIndexed({ hooks: [{}], skills: [{}] })).toBeNull();
  });

  it.each([
    ["https://github.com/Acme/Plugins", { repo: "acme/plugins" }],
    ["github.com/acme/plugins.git", { repo: "acme/plugins" }],
    ["https://github.com/acme/plugins/tree/main/plugins/notes", { repo: "acme/plugins", ref: "main", path: "plugins/notes" }],
    ["https://github.com/acme/plugins@v1#plugins/notes", { repo: "acme/plugins", ref: "v1", path: "plugins/notes" }],
  ])("reads GitHub links: %s", (url, expected) => expect(parseGithubUrl(url)).toEqual(expected));
  it.each(["https://gitlab.com/acme/plugins", "https://github.com/acme", "https://user:x@github.com/acme/plugins", "https://github.com/acme/plugins#../x", "https://github.com/acme/plugins?ref=main"])(
    "refuses %s", url => expect(() => parseGithubUrl(url)).toThrow());
});
