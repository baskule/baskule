import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const run = (root, url) => new Promise((yes, no) => {
  const child = spawn("bash", ["deploy/celld/sync-plugins.sh", root, url], { env: { ...process.env, COMPUTERD_TOKEN: "test-installation-token" } });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  child.once("error", no);
  child.once("exit", code => yes({ code, stderr }));
});

test("collector sends all three standard entry kinds in one authenticated request; absent and empty mounts differ", async () => {
  mkdirSync(".run", { recursive: true });
  const work = mkdtempSync(resolve(".run/folder-collector-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ folder: { syncedAt: 1, problems: [] } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const root = `${work}/plugins`;
    assert.equal((await run(root, url)).code, 0);
    assert.deepEqual(requests.at(-1).body, { mounted: false });
    mkdirSync(root);
    assert.equal((await run(root, url)).code, 0);
    assert.deepEqual(requests.at(-1).body, { mounted: true, entries: [] });
    mkdirSync(`${root}/plugins/full/.claude-plugin`, { recursive: true });
    writeFileSync(`${root}/plugins/full/.claude-plugin/plugin.json`, '{"name":"Full"}');
    mkdirSync(`${root}/skills/voice`, { recursive: true });
    writeFileSync(`${root}/skills/voice/SKILL.md`, '---\nname: voice\ndescription: Write clearly\n---\nInstructions');
    mkdirSync(`${root}/mcp`);
    writeFileSync(`${root}/mcp/crm.json`, '{"mcpServers":{"crm":{"url":"https://example.test/mcp"}}}');
    symlinkSync(work, `${root}/plugins/link`);
    const result = await run(root, url);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].path, "/api/baskule/plugins/folder-sync");
    assert.equal(requests[2].auth, "Bearer test-installation-token");
    const entries = requests[2].body.entries;
    assert.deepEqual(entries.map(e => e.path), ["plugins/full", "plugins/link", "skills/voice", "mcp/crm.json"]);
    assert.equal(entries[1].problem, "plugin_links_unsupported");
    for (const entry of entries.filter(e => e.archive)) {
      assert.equal(Buffer.from(entry.archive, "base64").subarray(0, 2).toString("hex"), "1f8b");
    }
    // A malformed inventory fails before sending anything, so it cannot cause deletions.
    rmSync(`${root}/mcp`, { recursive: true });
    symlinkSync(work, `${root}/mcp`);
    assert.notEqual((await run(root, url)).code, 0);
    assert.equal(requests.length, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
});
