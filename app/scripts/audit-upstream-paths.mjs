import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [upstream, base, target, fork, checkout] = process.argv.slice(2);
if (!upstream || !base || !target || !fork) {
  throw new Error(
    "Usage: node app/scripts/audit-upstream-paths.mjs <upstream checkout> <base tag> <target tag> <fork commit> [app checkout]",
  );
}
const root = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const app = checkout ? NodePath.resolve(checkout) : NodePath.join(root, "app");
const git = (cwd, ...args) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
const basePaths = new Set(git(upstream, "ls-tree", "-rz", "--name-only", base));
const forkPaths = new Set(git(root, "ls-tree", "-rz", "--name-only", `${fork}:app`));
const changed = git(upstream, "diff", "--no-renames", "--name-only", "-z", base, target);
function directories(paths) {
  const result = new Set();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      result.add(parts.slice(0, index).join("/"));
    }
  }
  return result;
}
const baseDirectories = directories(basePaths);
const forkDirectories = directories(forkPaths);
const retiredTouchedPaths = changed.filter((path) => basePaths.has(path) && !forkPaths.has(path));
const newPathsInRetiredDirectories = changed.filter((path) => {
  if (basePaths.has(path)) return false;
  const parts = path.split("/");
  return parts.some((_, index) => {
    const parent = parts.slice(0, index).join("/");
    return baseDirectories.has(parent) && !forkDirectories.has(parent);
  });
});
const reintroducedPaths = [...retiredTouchedPaths, ...newPathsInRetiredDirectories].filter((path) =>
  NodeFS.existsSync(NodePath.join(app, path)),
);
console.log(
  JSON.stringify(
    { base, target, fork, retiredTouchedPaths, newPathsInRetiredDirectories, reintroducedPaths },
    null,
    2,
  ),
);
if (reintroducedPaths.length > 0) process.exitCode = 1;
