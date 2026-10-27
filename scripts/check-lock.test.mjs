import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireHostLock } from "./check-lock.mjs";

const moduleURL = new URL("./check-lock.mjs", import.meta.url).href;

function worker(t, directory, checkout) {
  const cwd = join(directory, checkout);
  mkdirSync(cwd);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireHostLock } from ${JSON.stringify(moduleURL)};
    process.send("waiting");
    const release = await acquireHostLock("web", { directory: ${JSON.stringify(directory)} });
    process.send("acquired");
    process.once("message", () => { release(); process.disconnect(); });
  `], { cwd, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  return child;
}

function message(child, expected) {
  return new Promise((resolve, reject) => {
    const onMessage = (value) => {
      if (value === expected) { child.off("message", onMessage); child.off("exit", onExit); resolve(); }
    };
    const onExit = (code, signal) => { child.off("message", onMessage); reject(new Error(`worker exited ${signal ?? code} before ${expected}`)); };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

for (const killed of [false, true]) {
  test(`same host lock serializes separate checkouts; release on ${killed ? "process death" : "cleanup"}`, { timeout: 15000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "baskule-lock-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = worker(t, directory, "runner-one");
    await message(first, "acquired");
    const second = worker(t, directory, "runner-two");
    let released = false;
    let premature = false;
    second.on("message", (value) => { if (value === "acquired" && !released) premature = true; });
    const acquired = message(second, "acquired");
    await message(second, "waiting");

    // A different port group can proceed, but a bounded wait on this group fails without taking it.
    const releaseSpace = await acquireHostLock("space", { directory, timeout: 0 });
    releaseSpace();
    await assert.rejects(acquireHostLock("web", { directory, timeout: 0 }), /host lock web: flock exited 1/);
    assert.equal(premature, false);

    const firstExit = once(first, "exit");
    released = true;
    if (killed) first.kill("SIGKILL");
    else first.send("cleanup finished");
    await firstExit;
    await acquired;
    assert.equal(premature, false);
    // The second process retains ownership after the short-lived flock child has exited.
    assert.equal(spawnSync("flock", ["--nonblock", join(directory, "web.lock"), "true"]).status, 1);
    const secondExit = once(second, "exit");
    second.send("cleanup finished");
    assert.deepEqual(await secondExit, [0, null]);
    assert.equal(spawnSync("flock", ["--nonblock", join(directory, "web.lock"), "true"]).status, 0);
  });
}

test("CI can keep its locks in its own shared root", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "osdev-ci-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { acquireHostLock } from ${JSON.stringify(moduleURL)}; const release = await acquireHostLock("ci-proof"); release();`], { encoding: "utf8", env: { ...process.env, BASKULE_CHECK_LOCK_DIR: directory } });
  assert.equal(r.status, 0, r.stderr); assert(existsSync(join(directory, "ci-proof.lock")));
});
