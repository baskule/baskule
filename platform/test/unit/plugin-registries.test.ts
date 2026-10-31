import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { McpRegistry } from "../../src/control/registries/mcp";
import { GithubMarketplace } from "../../src/control/registries/marketplace";
import { searchRegistries } from "../../src/control/registries";
import { fetchBytes, SOURCE_TIMEOUT_MS } from "../../src/control/registries/http";
import { fetchGitFiles } from "../../src/control/registries/git";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/plugins/${name}`, import.meta.url), "utf8"));
const sha = "a".repeat(40);

describe("registry adapters (recorded public JSON; no network)", () => {
  it("MCP search excludes stdio and malformed entries; resolve uses the selected version and remote headers metadata", async () => {
    const recorded = fixture("mcp.json");
    const calls: string[] = [];
    const adapter = new McpRegistry(async url => { calls.push(String(url)); return Response.json(calls.length === 1 ? recorded : recorded.servers[0]); });
    const results = await adapter.search("github", "mcp");
    expect(results).toHaveLength(1);
    expect(results[0].source.version).toBe(recorded.servers[0].server.version);
    const resolved = await adapter.resolve(results[0].id, results[0].source.version);
    expect(calls[0]).toContain("search=github");
    expect(calls[1]).toContain(encodeURIComponent(results[0].id));
    expect(resolved.servers![0]).toMatchObject({ credential: "organization" });
    expect(await adapter.search("x", "skill")).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("marketplaces resolve relative and external sources to pinned commits", async () => {
    const adapter = new GithubMarketplace("knowledge", "anthropics/knowledge-work-plugins", async url => Response.json(String(url).includes("/commits/") ? { sha } : fixture("marketplace.json")));
    const results = await adapter.search("productivity", "bundle");
    expect(results[0].source.version).toBe(sha);
    expect(await adapter.resolve("productivity", sha)).toMatchObject({ source: { type: "git", ref: sha, repo: "https://github.com/anthropics/knowledge-work-plugins", path: "productivity" } });
    expect(await adapter.resolve("noibu", sha)).toMatchObject({ source: { ref: "9fa2eddc3a86937b7956dedfaab32fac6cabf868", path: "src" } });
  });

  it("the skill catalog never offers or resolves the proprietary document collection", async () => {
    const adapter = new GithubMarketplace("skills", "anthropics/skills", async url => Response.json(String(url).includes("/commits/") ? { sha } : fixture("skills-marketplace.json")), ["example-skills"]);
    expect((await adapter.search("", "skill")).map(r => r.id)).toEqual(["example-skills"]);
    const resolved = await adapter.resolve("example-skills", sha);
    expect(resolved.skillPaths).not.toContain("./skills/docx");
    await expect(adapter.resolve("document-skills", sha)).rejects.toMatchObject({ code: "registry_plugin_not_found" });
    await expect(adapter.resolve("example-skills", "main")).rejects.toMatchObject({ code: "invalid_commit" });
  });

  it("resolves the Codex marketplace's local object sources", async () => {
    const urls: string[] = [];
    const adapter = new GithubMarketplace("codex", "openai/plugins", async url => { urls.push(String(url)); return Response.json(fixture("codex-marketplace.json")); }, undefined, ".agents/plugins/marketplace.json");
    expect(await adapter.resolve("linear", sha)).toMatchObject({ source: { type: "git", path: "plugins/linear", ref: sha } });
    expect(urls[0]).toContain("/.agents/plugins/marketplace.json");
  });

  it("reports a failed source while keeping other results", async () => {
    const good = { id: "good", search: async () => [], resolve: vi.fn() };
    const bad = { ...good, id: "bad", search: async () => { throw new Error("offline"); } };
    expect(await searchRegistries([good, bad], "x")).toEqual({ results: [], failures: [{ registry: "bad", error: "unavailable" }] });
  });

  it("fetches only the selected pinned directory and inherited license", async () => {
    const paths: string[] = [];
    const encoder = new TextEncoder();
    const files = { "LICENSE": "MIT", "plugin/SKILL.md": "skill", "unrelated/asset": "large" };
    const result = await fetchGitFiles(async url => {
      paths.push(String(url));
      if (String(url).includes("/git/trees/")) return Response.json({ truncated: false, tree: Object.entries(files).map(([path, contents]) => ({ path, mode: "100644", type: "blob", size: encoder.encode(contents).length })) });
      return new Response(files[String(url).split(`${sha}/`)[1] as keyof typeof files]);
    }, { type: "git", repo: "https://github.com/example/plugin", ref: sha, path: "plugin" });
    expect([...result.keys()]).toEqual(["LICENSE", "plugin/SKILL.md"]);
    expect(paths).toHaveLength(3);
    expect(paths.some(p => p.includes("unrelated"))).toBe(false);
    await expect(fetchGitFiles(async () => Response.json({ truncated: true, tree: [] }), { type: "git", repo: "https://github.com/example/plugin", ref: sha })).rejects.toMatchObject({ code: "plugin_tree_too_large" });
  });

  it("aborts a stalled source", async () => {
    vi.useFakeTimers();
    try {
      const pending = fetchBytes(async (_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
      }), "https://example.test", 20);
      const assertion = expect(pending).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
});
