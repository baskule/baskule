#!/usr/bin/env node
// deploy/.env.example is the source for release assets and the inline installation examples.
import { readFileSync, writeFileSync } from "node:fs";
const source = readFileSync(new URL("../deploy/.env.example", import.meta.url), "utf8").trim();
for (const [file, block] of [["docs/install.md", source]]) {
  const url = new URL(`../${file}`, import.meta.url);
  const before = readFileSync(url, "utf8");
  if (!before.includes("<!-- install-env:start -->") || !before.includes("<!-- install-env:end -->")) throw new Error(`${file}: missing install-env markers`);
  const after = before.replace(/<!-- install-env:start -->[\s\S]*?<!-- install-env:end -->/, `<!-- install-env:start -->\n\x60\x60\x60dotenv\n${block}\n\x60\x60\x60\n<!-- install-env:end -->`);
  if (before === after) continue;
  if (process.argv.includes("--check")) throw new Error(`${file}: run node scripts/install-env-docs.mjs`);
  writeFileSync(url, after);
}
