import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { CatalogCache, REGISTRIES, dedupe, loadRegistry, parseIndex, type CachedSource, type StoredEntry } from "../../src/control/plugins/catalog";
import { fakeFetch, ok } from "../support/fake-fetch";

const fixture = (path: string) => readFileSync(new URL(`../fixtures/marketplace/${path}`, import.meta.url), "utf8");
const [CURSOR_SHA, XAI_SHA] = fixture("SHAS").trim().split("\n") as [string, string];
const TREE = "1".repeat(40);
const registry = (id: string) => REGISTRIES.find(r => r.id === id)!;
const [cursor, xai, anthropic] = [registry("cursor"), registry("xai"), registry("anthropic")];
const raw = (repo: string, sha: string, path: string) => `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;

function cursorRoutes() {
  const routes: Record<string, Response> = {
    "https://api.github.com/repos/cursor/plugins/commits/HEAD": ok({ sha: CURSOR_SHA, commit: { tree: { sha: TREE } } }),
    [`https://api.github.com/repos/cursor/plugins/git/trees/${TREE}?recursive=1`]: ok(fixture("cursor/tree.json")),
    [raw("cursor/plugins", CURSOR_SHA, ".cursor-plugin/marketplace.json")]: ok(fixture("cursor/marketplace.json")),
  };
  for (const name of ["gmail", "netsuite", "github"]) {
    routes[raw("cursor/plugins", CURSOR_SHA, `third_party/${name}/.cursor-plugin/plugin.json`)] = ok(fixture(`cursor/${name}/plugin.json`));
    routes[raw("cursor/plugins", CURSOR_SHA, `third_party/${name}/mcp.json`)] = ok(fixture(`cursor/${name}/mcp.json`));
  }
  return routes;
}

describe("registry indexes", () => {
  it("resolves the real Cursor and xAI index sources to pinned GitHub directories", () => {
    const fromCursor = parseIndex(fixture("cursor/marketplace.json"), cursor, CURSOR_SHA);
    expect(fromCursor).toHaveLength(134);
    expect(fromCursor.find(e => e.name === "gmail")).toEqual({ name: "gmail", displayName: null, skills: 0, description: "Search, read, draft, and manage email.", keywords: [], category: null,
      homepage: null, domains: [], repo: "cursor/plugins", path: "third_party/gmail", sha: CURSOR_SHA });
    const fromXai = parseIndex(fixture("xai/marketplace.json"), xai, XAI_SHA);
    expect(fromXai).toHaveLength(36);
    expect(fromXai.find(e => e.name === "neon")).toMatchObject({ repo: "xai-org/plugin-marketplace", path: "external_plugins/neon", sha: XAI_SHA });
    expect(fromXai.find(e => e.name === "axiom")).toMatchObject({ repo: "axiomhq/skills", sha: "bd3d648821b12ccbf7d0c74aecbf504cead1bfad", category: "observability" });
    expect(fromXai.find(e => e.name === "axiom")).not.toHaveProperty("path");
  });

  it("lists vendored Cursor plugins that install completely, with logos pinned to the commit", async () => {
    const { fetcher, seen } = fakeFetch(cursorRoutes());
    const data = await loadRegistry(fetcher, cursor, null);
    expect(data.sha).toBe(CURSOR_SHA);
    // continual-learning ships hooks/, which only run inside an editor.
    expect(data.entries.map(e => e.name)).toEqual(["github", "gmail", "netsuite"]);
    expect(data.entries.find(e => e.name === "gmail")).toEqual({
      id: "cursor:https://github.com/cursor/plugins#third_party/gmail", source: "cursor", name: "gmail", displayName: "Gmail",
      description: "Search, read, draft, and manage email.", logo: raw("cursor/plugins", CURSOR_SHA, "third_party/gmail/assets/logo.svg"),
      homepage: null, domains: ["googleapis.com"], keywords: ["gmailmcp.googleapis.com"], category: "communication", recommended: false, hasServers: true, skillCount: 0,
      ref: { repo: "cursor/plugins", path: "third_party/gmail", sha: CURSOR_SHA },
    });
    // ${NETSUITE_MCP_URL} is a variable the administrator fills in, not a reason to hide the plugin.
    expect(data.entries.find(e => e.name === "netsuite")).toMatchObject({ displayName: "NetSuite", hasServers: true, logo: expect.stringContaining(`/${CURSOR_SHA}/third_party/netsuite/assets/logo.png`) });
    expect(data.entries.find(e => e.name === "github")).toMatchObject({ recommended: true, category: "code" });
    expect(seen.filter(s => s.url.includes("/HEAD/"))).toEqual([]);
    const again = fakeFetch(cursorRoutes());
    const reused = await loadRegistry(again.fetcher, cursor, data);
    expect(reused.entries).toEqual(data.entries);
    expect(again.seen.map(s => s.url)).toEqual(["https://api.github.com/repos/cursor/plugins/commits/HEAD"]);
  });

  it("classifies xAI entries from the component index and reads manifests of pinned external repos", async () => {
    const { fetcher } = fakeFetch({
      "https://api.github.com/repos/xai-org/plugin-marketplace/commits/HEAD": ok({ sha: XAI_SHA, commit: { tree: { sha: TREE } } }),
      [raw("xai-org/plugin-marketplace", XAI_SHA, ".grok-plugin/marketplace.json")]: ok(fixture("xai/marketplace.json")),
      [raw("xai-org/plugin-marketplace", XAI_SHA, ".grok-plugin/plugin-index.json")]: ok(fixture("xai/plugin-index.json")),
      [raw("xai-org/plugin-marketplace", XAI_SHA, "external_plugins/neon/.grok-plugin/plugin.json")]: ok(fixture("xai/neon/plugin.json")),
      [raw("axiomhq/skills", "bd3d648821b12ccbf7d0c74aecbf504cead1bfad", ".grok-plugin/plugin.json")]: ok(fixture("xai/axiom/plugin.json")),
    });
    const data = await loadRegistry(fetcher, xai, null);
    const names = data.entries.map(e => e.name);
    expect(names).toContain("axiom");
    expect(names).not.toContain("vercel");
    expect(names).not.toContain("superpowers");
    expect(data.entries.find(e => e.name === "neon")).toMatchObject({ logo: raw("xai-org/plugin-marketplace", XAI_SHA, "external_plugins/neon/assets/logo.svg"), category: "data", recommended: true });
    expect(data.entries.find(e => e.name === "axiom")).toMatchObject({ hasServers: true, skillCount: 8, category: "ops", logo: null,
      ref: { repo: "axiomhq/skills", sha: "bd3d648821b12ccbf7d0c74aecbf504cead1bfad" } });
  });

  it("lists Anthropic plugins pinned to vendor repositories by their hosted servers alone, and reads each pin once", async () => {
    const SHA = "a".repeat(40), NEXT = "b".repeat(40), VENDOR = "c".repeat(40), LOCAL = "d".repeat(40);
    const index = { plugins: [
      // Vendored: a pack whose optional Gmail slot has no address yet still lists.
      { name: "sales", displayName: "Sales", description: "Sales skills", source: "./sales" },
      // Claude Code developer tooling: skills only.
      { name: "commit-commands", description: "Git", source: "./plugins/commit-commands" },
      { name: "stripe", description: "Payments", category: "productivity", source: { source: "git-subdir", url: "https://github.com/stripe/ai.git", path: "providers/claude/plugin", ref: "main", sha: VENDOR } },
      { name: "local-db", description: "Runs a program", source: { source: "url", url: "https://github.com/acme/db.git", sha: VENDOR } },
      { name: "pyright-lsp", description: "Types", source: "./plugins/pyright-lsp", lspServers: { pyright: { command: "pyright" } } },
    ] };
    const tree = (sha: string) => ({ tree: [
      { path: "sales/.claude-plugin/plugin.json", type: "blob", mode: "100644", size: 50 },
      { path: "sales/.mcp.json", type: "blob", mode: "100644", size: 100 },
      { path: "sales/skills/call-prep/SKILL.md", type: "blob", mode: "100644", size: 100 },
      { path: "plugins/commit-commands/commands/commit.md", type: "blob", mode: "100644", size: 100 },
      { path: `plugins/pyright-lsp/README-${sha}.md`, type: "blob", mode: "100644", size: 10 },
    ] });
    const routes = (sha: string) => ({
      "https://api.github.com/repos/anthropics/claude-plugins-official/commits/HEAD": ok({ sha, commit: { tree: { sha: LOCAL } } }),
      [`https://api.github.com/repos/anthropics/claude-plugins-official/git/trees/${LOCAL}?recursive=1`]: ok(tree(sha)),
      [raw("anthropics/claude-plugins-official", sha, ".claude-plugin/marketplace.json")]: ok(index),
      [raw("anthropics/claude-plugins-official", sha, "sales/.mcp.json")]: ok({ mcpServers: { hubspot: { type: "http", url: "https://mcp.hubspot.com/anthropic" }, gmail: { type: "http", url: "" } } }),
      [raw("anthropics/claude-plugins-official", sha, "sales/.claude-plugin/plugin.json")]: ok({ name: "sales" }),
      [raw("stripe/ai", VENDOR, "providers/claude/plugin/.claude-plugin/plugin.json")]: ok({ name: "stripe", displayName: "Stripe" }),
      [raw("stripe/ai", VENDOR, "providers/claude/plugin/.mcp.json")]: ok({ mcpServers: { stripe: { type: "http", url: "https://mcp.stripe.com" } } }),
      [raw("acme/db", VENDOR, ".mcp.json")]: ok({ mcpServers: { db: { command: "npx", args: ["acme-db"] } } }),
    });
    const first = fakeFetch(routes(SHA));
    const data = await loadRegistry(first.fetcher, anthropic, null);
    expect(data.entries.map(e => e.name)).toEqual(["sales", "stripe"]);
    expect(data.entries.find(e => e.name === "sales")).toMatchObject({ displayName: "Sales", hasServers: true, skillCount: 1, category: "sales", domains: [], keywords: ["mcp.hubspot.com"] });
    expect(data.entries.find(e => e.name === "stripe")).toMatchObject({ id: "anthropic:https://github.com/stripe/ai#providers/claude/plugin", hasServers: true,
      domains: ["stripe.com"], keywords: ["mcp.stripe.com"], recommended: true, ref: { repo: "stripe/ai", path: "providers/claude/plugin", sha: VENDOR } });
    // Vendor repositories are read without the GitHub API.
    expect(first.seen.filter(s => s.url.startsWith("https://api.github.com/") && !s.url.includes("claude-plugins-official"))).toEqual([]);
    const next = fakeFetch(routes(NEXT));
    const again = await loadRegistry(next.fetcher, anthropic, data);
    expect(again.entries.map(e => e.name)).toEqual(["sales", "stripe"]);
    expect(next.seen.filter(s => s.url.includes("stripe/ai") || s.url.includes("acme/db"))).toEqual([]);
  });

  it("lists one brand once across registries, preferring a logo and then the earlier registry", () => {
    const entry = (source: "anthropic" | "cursor" | "xai", name: string, logo: string | null) => ({ id: `${source}:${name}`, source, name, displayName: name, description: "d", logo } as StoredEntry);
    expect(dedupe([entry("xai", "Figma", "x"), entry("cursor", "figma", null), entry("xai", "Linear", null), entry("cursor", "linear", null),
      entry("cursor", "Apollo.io", null), entry("anthropic", "Apollo Skills", null), entry("xai", "Atlassian MCP", null), entry("cursor", "Atlassian", null)]).map(e => e.id).sort())
      .toEqual(["anthropic:Apollo Skills", "cursor:Atlassian", "cursor:linear", "xai:Figma"]);
  });
});

describe("catalog cache", () => {
  const kv = () => {
    const values = new Map<string, string>();
    return { values, get: (k: string) => values.get(k), put: (k: string, v: string) => void values.set(k, v), delete: (k: string) => void values.delete(k) };
  };
  const source = (fetchedAt: number, names: string[]): CachedSource => ({ fetchedAt, entries: names.map(name => ({ id: `cursor:${name}`, source: "cursor", name, displayName: name,
    description: "", logo: null, homepage: null, domains: [], keywords: [], category: null, recommended: false, hasServers: true, skillCount: 0, ref: { repo: "a/b", path: name, sha: "c".repeat(40) } })) });
  const providers = { composio: false, pipedream: false };

  it("serves a stale copy while it revalidates, never caches failures, and refreshes on demand", async () => {
    const store = kv();
    let release: (() => void) | undefined;
    let result: CachedSource | Error = source(Date.now(), ["fresh"]);
    const calls: string[] = [];
    const cache = new CatalogCache(store, s => s === "cursor" ? async () => {
      calls.push(s);
      await new Promise<void>(resolve => { release = resolve; });
      if (result instanceof Error) throw result;
      return result;
    } : null, 0);
    store.put("catalog:cursor", JSON.stringify(source(Date.now() - 2 * 60 * 60_000, ["stale"])));
    const stale = await cache.catalog(false, providers, new Map(), () => "");
    expect(stale.entries.map(e => e.name)).toEqual(["stale"]);
    expect(calls).toEqual(["cursor"]);
    release!();
    await expect.poll(() => JSON.parse(store.get("catalog:cursor")!).entries[0].name).toBe("fresh");
    result = new Error("GitHub is down");
    const forced = cache.catalog(true, providers, new Map([["github:a/b#fresh", "installed-id"]]), ref => "repo" in ref ? `github:${ref.repo}#${ref.path}` : "");
    await expect.poll(() => release).toBeDefined();
    release!();
    const failed = await forced;
    expect(failed.entries).toEqual([expect.objectContaining({ name: "fresh", installedPluginId: "installed-id" })]);
    expect(failed.unavailable).toEqual([{ source: "cursor", message: "GitHub is down" }]);
    expect(JSON.parse(store.get("catalog:cursor")!).entries[0].name).toBe("fresh");
  });
});
