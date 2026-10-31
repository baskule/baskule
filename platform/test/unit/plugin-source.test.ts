import { describe, expect, it, vi } from "vitest";
import { fetchBytes, SOURCE_TIMEOUT_MS, fetchGitFiles } from "../../src/control/plugin-source";
const sha = "a".repeat(40);
describe("plugin source", () => {
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
