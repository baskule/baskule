// Computer integration feedback loop: node scripts/test-baskule-search.mjs
// Requires the locally built baskule-computer:0.2 image. No running stack needed.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { COMPUTER_SEARCH_SCRIPT } from "../src/baskule/workerd/computerSearch.ts";

const fixture = mkdtempSync(join(tmpdir(), "baskule-search-"));
try {
  chmodSync(fixture, 0o755);
  mkdirSync(join(fixture, "docs"));
  mkdirSync(join(fixture, ".git"));
  writeFileSync(join(fixture, "docs", "notes.txt"), "Café hello HELLO\nhelloWorld\n[broken\n");
  writeFileSync(join(fixture, "photo.png"), Buffer.from([0, 1, 2]));
  writeFileSync(join(fixture, ".git", "secret"), "hello\n");
  symlinkSync("/etc", join(fixture, "escape"));
  const run = (input) =>
    JSON.parse(
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--network=none",
          "--user=1000:1000",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--memory=128m",
          "--cpus=0.5",
          "-v",
          `${fixture}:/sandbox:ro`,
          "baskule-computer:0.2",
          "node",
          "-e",
          COMPUTER_SEARCH_SCRIPT,
          JSON.stringify({
            cwd: "/sandbox",
            query: "hello",
            limit: 20,
            caseSensitive: false,
            wholeWord: false,
            useRegex: false,
            ...input,
          }),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 25000 },
      ),
    );
  assert.deepEqual(run({ mode: "paths", query: "notes" }).entries, [
    { path: "docs/notes.txt", kind: "file" },
  ]);
  assert.deepEqual(run({ mode: "paths", query: "", kind: "directory" }).entries, [
    { path: "docs", kind: "directory" },
  ]);
  assert.deepEqual(run({ mode: "paths", query: "", imageOnly: true }).entries, [
    { path: "photo.png", kind: "file" },
  ]);
  assert.equal(run({ mode: "paths", query: "", limit: 1 }).truncated, true);
  const words = run({ mode: "contents", wholeWord: true });
  assert.equal(words.matches.length, 1);
  assert.deepEqual(words.matches[0].matchRanges, [
    { start: 5, end: 10 },
    { start: 11, end: 16 },
  ]);
  assert.equal(
    run({ mode: "contents", caseSensitive: true, wholeWord: true }).matches[0].matchRanges.length,
    1,
  );
  assert.equal(run({ mode: "contents", useRegex: true, query: "h.llo", limit: 1 }).truncated, true);
  const fallback = run({ mode: "contents", useRegex: true, query: "[broken" });
  assert.ok(fallback.regexFallbackError);
  assert.equal(fallback.matches[0].lineNumber, 3);
  assert.throws(() => run({ mode: "contents", cwd: "/sandbox/escape" }));
  assert.throws(() => run({ mode: "paths", cwd: "/etc" }));
  console.log(
    "Computer search: 10 integration assertions passed (paths, filters, regex fallback, UTF-16 ranges, truncation, confinement).",
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
