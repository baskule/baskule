import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { IMPORT_LIMITS, inspectPackage, unpackArchive, exportPackage, skillFromInput } from "../../src/control/plugin-package";

export function bundleFixture(name: string): Map<string, Uint8Array> {
  const root = new URL(`../fixtures/plugins/${name}/`, import.meta.url);
  return new Map(readdirSync(root, { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => {
    const path = join(f.parentPath, f.name);
    return [path.slice(root.pathname.length), new Uint8Array(readFileSync(path))];
  }));
}

describe("bounded portable bundle importer", () => {
  it("normalizes skills, binary assets, and remotes while omitting stdio, client extensions, and embedded credentials", () => {
    const input = zipSync(Object.fromEntries(bundleFixture("portable")));
    const p = inspectPackage(unpackArchive(input), { source: { type: "custom" } }).plugin;
    expect(p.servers.map(s => s.name)).toEqual(["docs", "account", "secret"]);
    expect(p.servers.find(s => s.name === "account")).toMatchObject({ credential: "user-oauth" });
    expect(JSON.stringify(p.omitted)).toContain("local_program");
    expect(JSON.stringify(p.omitted)).toContain("com.example.client");
    expect(JSON.stringify(p)).not.toContain("DO-NOT-STORE");
    expect(p.skills[0].description).toBe("Greet a teammate.\n");
    expect(p.skills[0].files.find(f => f.path === "assets/pixel.bin")?.content).toBe("AP+AAA==");
    expect(p.skills[0].files.some(f => f.path.startsWith("licenses/") && atob(f.content).includes("MIT"))).toBe(true);
  });

  it.each(["claude", "codex", "bare"])("accepts the %s layout", name => {
    const p = inspectPackage(bundleFixture(name), { source: { type: "custom" } }).plugin;
    if (name === "claude") expect(JSON.stringify(p.omitted)).toContain("commands");
  });

  it("omits bundled credentials and client configuration from a bare skill's files", () => {
    const files = bundleFixture("bare");
    files.set(".mcp.json", new TextEncoder().encode(JSON.stringify({ mcpServers: {
      docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer PRIVATE-BUNDLE-KEY" } },
    } })));
    files.set(".claude-plugin/plugin.json", new TextEncoder().encode(JSON.stringify({ name: "bare" })));
    const p = inspectPackage(files, { source: { type: "custom" } }).plugin;
    expect(p.servers[0].credential).toBe("organization");
    expect(p.skills[0].files.map(f => f.path)).toEqual([]);
    expect(JSON.stringify(p)).not.toContain("PRIVATE-BUNDLE-KEY");
  });

  it("accepts uploaded tar.gz skills and rejects tar/ZIP symbolic links", () => {
    const read = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/plugins/${name}`, import.meta.url)));
    expect(inspectPackage(unpackArchive(read("bare.tar.gz")), { source: { type: "custom" } }).plugin.skills[0].name).toBe("bare");
    for (const name of ["symlink.tar.gz", "symlink.zip"]) expect(() => unpackArchive(read(name))).toThrow("plugin_links_unsupported");
  });

  it("selects the pinned repository subdirectory", () => {
    const input = new Map([...bundleFixture("portable")].map(([p, b]) => [`repo/pkg/${p}`, b]));
    expect(inspectPackage(input, { stripRoot: true, path: "pkg", source: { type: "custom" } }).plugin.skills).toHaveLength(1);
  });

  it("accepts a folder of several skills and reports invalid fields before save", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const draft = inspectPackage(new Map([
      ["one/SKILL.md", encode("---\nname: one\ndescription: First skill\n---\nOne\n")],
      ["two/SKILL.md", encode("---\nname: two\ndescription: Second skill\n---\nTwo\n")],
      ["bad/SKILL.md", encode('---\nname: bad\ndescription: "   "\n---\nBad\n')],
    ]), { source: { type: "custom" } });
    expect(draft.plugin.skills.map(s => s.name)).toEqual(["one", "two"]);
    expect(draft.omitted).toContainEqual({ code: "invalid_skill", subject: "bad" });
  });

  it("exports standard packages with placeholder keys and preserves skill files on re-import", () => {
    const draft = inspectPackage(bundleFixture("portable"), { source: { type: "custom" } });
    const zip = exportPackage(draft.plugin, draft.plugin.skills.map(skill => skillFromInput(skill, [])), { secret: ["Authorization"] });
    const roundtrip = inspectPackage(unpackArchive(zip), { source: { type: "custom" } });
    expect(roundtrip.plugin.skills).toEqual(draft.plugin.skills);
    expect(roundtrip.plugin.servers).toEqual(draft.plugin.servers);
    expect(roundtrip.fixes).toContainEqual({ server: "secret", need: "key", headers: ["Authorization"] });
    expect(JSON.stringify(roundtrip)).not.toContain("DO-NOT-STORE");
  });

  it("rejects traversal, bad archives, expansion bombs, and oversized skill files", () => {
    expect(() => unpackArchive(zipSync({ "../escape/SKILL.md": new Uint8Array([1]) }))).toThrow("unsafe_plugin_path");
    expect(() => unpackArchive(new Uint8Array([1, 2, 3]))).toThrow("Upload a ZIP");
    expect(() => unpackArchive(gzipSync(new Uint8Array(IMPORT_LIMITS.expanded + 1)))).toThrow("plugin_too_large");
    const files = bundleFixture("bare");
    files.set("asset", new Uint8Array(IMPORT_LIMITS.skillFile + 1));
    expect(() => inspectPackage(files, { source: { type: "custom" } }).plugin).toThrow("plugin_skill_file_too_large");
  });

  it("skips proprietary skills and malformed frontmatter without hiding usable remotes", () => {
    const files = bundleFixture("portable");
    files.set("skills/hello/LICENSE.txt", new TextEncoder().encode("Use governed by your agreement with Anthropic"));
    const p = inspectPackage(files, { source: { type: "custom" } }).plugin;
    expect(p.skills).toEqual([]);
    expect(JSON.stringify(p.omitted)).toContain("skill_license");
    files.delete("skills/hello/LICENSE.txt");
    files.set("skills/hello/SKILL.md", new TextEncoder().encode("no frontmatter"));
    expect(JSON.stringify(inspectPackage(files, { source: { type: "custom" } }).omitted)).toContain("invalid_skill");
  });
});
