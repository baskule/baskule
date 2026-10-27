// baskule: bounded search runs on the computer, never in the cell's event loop.
import type {
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import type { ComputerFs } from "./computerFs.ts";

// Arguments are JSON, never shell text. ripgrep uses its linear-time regex engine.
export const COMPUTER_SEARCH_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const input = JSON.parse(process.argv[1]);
const root = fs.realpathSync(input.cwd);
if (root !== "/sandbox" && !root.startsWith("/sandbox/")) throw new Error("Search root must be inside /sandbox");
if (root.split("/").includes(".git")) throw new Error("Search cannot read .git");
const limit = Math.min(1000, Math.max(1, input.limit));
let truncated = false;
if (input.mode === "paths") {
  const entries = [], pending = [""], query = input.query.toLowerCase();
  let visited = 0;
  while (pending.length && entries.length <= limit && visited < 20000) {
    const parent = pending.shift();
    for (const entry of fs.readdirSync(path.join(root, parent), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (++visited > 20000) { truncated = true; break; }
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      const name = parent ? parent + "/" + entry.name : entry.name;
      const kind = entry.isDirectory() ? "directory" : "file";
      if (entry.isDirectory()) pending.push(name);
      if (!entry.isDirectory() && !entry.isFile()) continue;
      if (input.kind && input.kind !== kind) continue;
      if (input.imageOnly && (kind !== "file" || !/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(name))) continue;
      if (name.toLowerCase().includes(query)) entries.push({path:name, kind});
      if (entries.length > limit) break;
    }
  }
  console.log(JSON.stringify({entries:entries.slice(0,limit),truncated:truncated || entries.length > limit || pending.length > 0}));
} else {
  const args = ["--json", "--hidden", "--glob", "!.git", "--max-filesize", "1M", "--max-columns", "20000", "--max-count", String(limit + 1)];
  if (!input.caseSensitive) args.push("--ignore-case");
  if (input.wholeWord) args.push("--word-regexp");
  const run = (literal) => spawnSync("rg", [...args, ...(literal ? ["--fixed-strings"] : []), "--", input.query, "."], {cwd:root,encoding:"utf8",timeout:15000,maxBuffer:8*1024*1024});
  let result = run(!input.useRegex), regexFallbackError;
  if (input.useRegex && result.status === 2 && /regex parse error|regex syntax error/.test(result.stderr || "")) {
    regexFallbackError = result.stderr.trim().slice(0,1000);
    result = run(true);
  }
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || "Search failed");
  const matches = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const item = JSON.parse(line);
    if (item.type !== "match" || !item.data.lines.text || !item.data.path.text) continue;
    if (matches.length === limit) {truncated = true; break;}
    const data = item.data, content = data.lines.text.replace(/\r?\n$/, "");
    const bytes = Buffer.from(data.lines.text);
    matches.push({path:data.path.text.replace(/^\.\//,""),lineNumber:data.line_number,lineContent:content,
      matchRanges:data.submatches.map(m => ({start:bytes.subarray(0,m.start).toString("utf8").length,end:bytes.subarray(0,m.end).toString("utf8").length}))});
  }
  console.log(JSON.stringify({matches,truncated,...(regexFallbackError ? {regexFallbackError} : {})}));
}
`;

export const makeComputerSearch = (computer: ComputerFs) => {
  const run = async (input: object) => {
    const result = await computer.exec([
      "node",
      "-e",
      COMPUTER_SEARCH_SCRIPT,
      JSON.stringify(input),
    ]);
    if (result.code !== 0)
      throw new Error(
        new TextDecoder().decode(result.stderr).slice(0, 1000) || "Computer search failed",
      );
    return JSON.parse(new TextDecoder().decode(result.stdout));
  };
  return {
    searchEntries: (input: ProjectSearchEntriesInput): Promise<ProjectSearchEntriesResult> =>
      run({ ...input, mode: "paths" }),
    searchContents: (input: ProjectSearchContentsInput): Promise<ProjectSearchContentsResult> =>
      run({ ...input, mode: "contents" }),
  };
};
