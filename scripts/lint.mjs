#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const owned = /^(?:platform\/|computerd\/v2\/|e2e\/(?:v2|journeys)\/|scripts\/|app\/apps\/(?:server\/src\/baskule\/|web\/(?:src\/baskule\/|baskule-dev\/)))/;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter((f) => owned.test(f) && /\.[cm]?[jt]sx?$/.test(f) && existsSync(root + f));
  console.log(`Blocking lint: ${files.length} Baskule-owned JS/TS files (including no-fixed-sleep in tests)`);
  const result = spawnSync(fileURLToPath(new URL("../app/node_modules/.bin/vp", import.meta.url)), ["lint", "--config", `${root}.oxlintrc.json`, "--deny-warnings", ...files.map((f) => root + f)], { cwd: `${root}app`, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exit(result.status !== 0 ? 1 : 0);
}
