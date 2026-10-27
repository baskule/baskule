import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { owned } from "./lint.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cases = [
  ["bare Promise timer", "case.test.ts", "await new Promise(r => setTimeout(r, 10));", false],
  ["multiline timer", "case.spec.mjs", "await new Promise(\n resolve => {\n setTimeout(resolve, 100);\n });", false],
  ["sleep helper", "test/case.js", "await sleep(100);", false],
  ["sync command", "e2e/case.ts", 'execFileSync("sleep", ["1"]);', false],
  ["browser timer", "case.test.ts", "await page.waitForTimeout(100);", false],
  ["returned browser timer", "case.test.ts", "return page.waitForTimeout(100);", false],
  ["namespaced timer", "case.test.ts", "await timers.setTimeout(100);", false],
  ["aliased timer", "case.test.ts", 'await delay(100);', false, 'import { setTimeout as delay } from "node:timers/promises";'],
  ["reasoned retry", "case.test.ts", "await sleep(100); // no-fixed-sleep-allow: Poll readiness until the deadline.", true],
  ["missing reason", "case.test.ts", "await sleep(100); // no-fixed-sleep-allow:", false],
  ["comment on another line", "case.test.ts", "// no-fixed-sleep-allow: Poll readiness.\nawait sleep(100);", false],
  ["fake comment in string", "case.test.ts", 'await sleep("// no-fixed-sleep-allow: Pretend reason.");', false],
  ["event wait", "case.test.ts", 'await new Promise(resolve => socket.once("close", resolve));', true],
  ["event with timeout", "case.test.ts", "await Promise.race([closed, sleep(100)]);", true],
  ["source example", "case.test.ts", 'return "await sleep(100)";', true],
  ["product timer", "source.ts", "await sleep(100);", true],
];
for (const [label, file, body, passes, imports = ""] of cases) {
  test(label, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "baskule-lint-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const actual = join(dir, file);
    mkdirSync(dirname(actual), { recursive: true });
    writeFileSync(actual, `${imports}\nexport async function exercise() { ${body}\n }`);
    const result = spawnSync(join(root, "app/node_modules/.bin/vp"), ["lint", "--config", join(root, ".oxlintrc.json"), actual], {
      cwd: join(root, "app"), encoding: "utf8",
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, passes ? 0 : 1, output);
    assert.equal(output.includes("baskule(no-fixed-sleep)"), !passes, output);
  });
}

test("lint ownership excludes upstream T3", () => {
  for (const file of ["platform/src/x.ts", "computerd/v2/src/x.ts", "e2e/v2/tests/x.ts", "scripts/x.mjs", "app/apps/server/src/baskule/x.ts", "app/apps/web/src/baskule/x.tsx", "app/apps/web/baskule-dev/x.mjs"]) assert.equal(owned.test(file), true, file);
  for (const file of ["app/apps/server/src/ws.ts", "app/apps/web/src/components/x.tsx", "app/packages/contracts/src/x.ts", "vendor/x.js"]) assert.equal(owned.test(file), false, file);
});
