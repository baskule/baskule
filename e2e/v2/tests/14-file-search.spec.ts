// Search crosses the real front, cell and authenticated computer boundary.
import { expect, test } from "@playwright/test";
import { cx, personApi, spaceRpc, world } from "./lib";

test("file search finds computer files and confines roots", { tag: ["@files"] }, async () => {
  const w = await world();
  const alice = await personApi(w.alice);
  const cwd = "/sandbox/space/search-e2e";
  cx(w.alice.personal, `mkdir -p ${cwd}/docs && printf 'Café hello HELLO\\nhelloWorld\\n[broken\\n' > ${cwd}/docs/notes.txt`);
  const call = async (tag: string, input: object) => {
    const result = await spaceRpc(alice, w.alice.personal, tag, { cwd, ...input });
    expect(result._tag, JSON.stringify(result)).toBe("Success");
    return result.value;
  };
  const paths = await call("projects.searchEntries", { query: "notes", limit: 20 });
  expect(paths.entries).toContainEqual({ path: "docs/notes.txt", kind: "file" });
  const matches = await call("projects.searchContents", { query: "hello", limit: 20, caseSensitive: false, wholeWord: true, useRegex: false });
  expect(matches.matches).toHaveLength(1);
  expect(matches.matches[0].matchRanges).toEqual([{ start: 5, end: 10 }, { start: 11, end: 16 }]);
  const fallback = await call("projects.searchContents", { query: "[broken", limit: 20, caseSensitive: true, wholeWord: false, useRegex: true });
  expect(fallback.regexFallbackError).toBeTruthy();
  expect(fallback.matches[0].lineNumber).toBe(3);
  const denied = await spaceRpc(alice, w.alice.personal, "projects.searchEntries", { cwd: "/baskule", query: "", limit: 20 });
  expect(denied._tag).toBe("Failure");
});
