import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

/** Host-shared across checkouts/runners. Keep the descriptor until all teardown finishes. */
export async function acquireHostLock(name, { directory = process.env.BASKULE_CHECK_LOCK_DIR || "/tmp/baskule-check-locks", timeout = 1800 } = {}) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.lock`);
  const fd = openSync(path, "a");
  console.log(`waiting for host lock ${name} (${path}, timeout ${timeout}s)`);
  try {
    await new Promise((resolve, reject) => {
      // flock and this process share the open file description. After flock exits, our descriptor
      // keeps its lock; normal step children do not inherit it. Process exit also releases it.
      const child = spawn("flock", ["--exclusive", "--wait", String(timeout), "3"], { stdio: ["ignore", "inherit", "inherit", fd] });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`host lock ${name}: flock exited ${signal ?? code} (wait limit ${timeout}s)`)));
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  console.log(`acquired host lock ${name} (${path})`);
  return () => { closeSync(fd); console.log(`released host lock ${name} (${path})`); };
}
