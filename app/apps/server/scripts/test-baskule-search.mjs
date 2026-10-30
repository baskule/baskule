// Computer integration feedback loop: node scripts/test-baskule-search.mjs
// Requires the locally built baskule-computer:0.2 image. No running stack needed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
import { COMPUTER_SEARCH_SCRIPT } from "../src/baskule/workerd/computerSearch.ts";

const fixture = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baskule-search-"));
try {
  NodeFS.chmodSync(fixture, 0o755);
  NodeFS.mkdirSync(NodePath.join(fixture, "docs"));
  NodeFS.mkdirSync(NodePath.join(fixture, ".git"));
  NodeFS.writeFileSync(
    NodePath.join(fixture, "docs", "notes.txt"),
    "Café hello HELLO\nhelloWorld\n[broken\n",
  );
  NodeFS.writeFileSync(NodePath.join(fixture, "photo.png"), Buffer.from([0, 1, 2]));
  NodeFS.writeFileSync(NodePath.join(fixture, ".git", "secret"), "hello\n");
  NodeFS.symlinkSync("/etc", NodePath.join(fixture, "escape"));
  const run = (input) =>
    JSON.parse(
      NodeChildProcess.execFileSync(
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
  NodeAssert.deepEqual(run({ mode: "paths", query: "notes" }).entries, [
    { path: "docs/notes.txt", kind: "file" },
  ]);
  NodeAssert.deepEqual(run({ mode: "paths", query: "", kind: "directory" }).entries, [
    { path: "docs", kind: "directory" },
  ]);
  NodeAssert.deepEqual(run({ mode: "paths", query: "", imageOnly: true }).entries, [
    { path: "photo.png", kind: "file" },
  ]);
  NodeAssert.equal(run({ mode: "paths", query: "", limit: 1 }).truncated, true);
  const words = run({ mode: "contents", wholeWord: true });
  NodeAssert.equal(words.matches.length, 1);
  NodeAssert.deepEqual(words.matches[0].matchRanges, [
    { start: 5, end: 10 },
    { start: 11, end: 16 },
  ]);
  NodeAssert.equal(
    run({ mode: "contents", caseSensitive: true, wholeWord: true }).matches[0].matchRanges.length,
    1,
  );
  NodeAssert.equal(
    run({ mode: "contents", useRegex: true, query: "h.llo", limit: 1 }).truncated,
    true,
  );
  const fallback = run({ mode: "contents", useRegex: true, query: "[broken" });
  NodeAssert.ok(fallback.regexFallbackError);
  NodeAssert.equal(fallback.matches[0].lineNumber, 3);
  NodeAssert.throws(() => run({ mode: "contents", cwd: "/sandbox/escape" }));
  NodeAssert.throws(() => run({ mode: "paths", cwd: "/etc" }));
  console.log(
    "Computer search: 10 integration assertions passed (paths, filters, regex fallback, UTF-16 ranges, truncation, confinement).",
  );
} finally {
  NodeFS.rmSync(fixture, { recursive: true, force: true });
}
