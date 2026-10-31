import { describe, expect, it, vi } from "vitest";
import { resolveGithubLink, fetchBytes, SOURCE_TIMEOUT_MS, fetchGitFiles } from "../../src/control/plugin-source";
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
    }, { type: "github", repo: "https://github.com/example/plugin", sha, path: "plugin" });
    expect([...result.keys()]).toEqual(["LICENSE", "plugin/SKILL.md"]);
    expect(paths).toHaveLength(3);
    expect(paths.some(p => p.includes("unrelated"))).toBe(false);
    await expect(fetchGitFiles(async () => Response.json({ truncated: true, tree: [] }), { type: "github", repo: "https://github.com/example/plugin", sha })).rejects.toMatchObject({ code: "plugin_tree_too_large" });
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

describe("GitHub links", () => {
  it.each([
    ["example/plugin", "HEAD", undefined],
    ["https://github.com/example/plugin.git", "HEAD", undefined],
    ["https://github.com/example/plugin/tree/main", "main", undefined],
    ["https://github.com/example/plugin/tree/main/skills/hello", "main", "skills/hello"],
    ["https://github.com/example/plugin/blob/feature/work/skills/hello/SKILL.md", "feature/work", "skills/hello"],
    [`https://github.com/example/plugin/commit/${sha}`, sha, undefined],
  ])("pins %s", async (link, ref, path) => {
    const requests: string[] = [];
    const source = await resolveGithubLink(async url => {
      requests.push(String(url));
      return decodeURIComponent(String(url).split("/commits/")[1]) === ref ? new Response(sha + "\n") : new Response(null, { status: 404 });
    }, link);
    expect(source).toEqual({ type: "github", repo: "https://github.com/example/plugin", sha, ...(path ? { path } : {}) });
    expect(requests.length).toBeLessThanOrEqual(5);
  });
  it.each(["https://other.test/o/r", "https://user:password@github.com/o/r", "https://github.com/o/r/issues/3", "https://github.com/o/r/tree"])("rejects %s", async link => {
    await expect(resolveGithubLink(async () => { throw new Error("unexpected fetch"); }, link)).rejects.toMatchObject({ code: "github_link_invalid" });
  });
});
