import fs from "node:fs";
import fsp from "node:fs/promises";
import { expect, it } from "vitest";
import { createCaptureScope, shimFiles } from "../../src/agent/fs-shim.js";

it("isolates shell captures and drops a closed Space's buffers and late writers", async () => {
  const path = "/capture/shared";
  let first: ReturnType<typeof fs.createWriteStream> | undefined;
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const firstScope = createCaptureScope("capture-a");
  const otherScope = createCaptureScope("capture-b");
  const replacement = createCaptureScope("capture-a");
  const late = firstScope.run(async () => {
    first = fs.createWriteStream(path);
    first.write("first");
    expect(shimFiles.has(path)).toBe(true);
    await gate;
    return fs.createWriteStream(path);
  });
  try {
    await otherScope.run(async () => {
      expect(shimFiles.has(path)).toBe(false);
      const other = fs.createWriteStream(path);
      other.write("other");
      replacement.run(() => { fs.createWriteStream(path).write("replacement"); });
      firstScope.release();
      replacement.run(() => { expect(shimFiles.get(path)?.size).toBe(11); });
      expect(first?.write("late bytes")).toBe(false);
      expect(shimFiles.get(path)?.size).toBe(5);
      await fsp.unlink(path);
      expect(shimFiles.has(path)).toBe(false);
    });
    unblock();
    await expect(late).rejects.toThrow("no live Space owner");
  } finally {
    unblock();
    firstScope.release(); otherScope.release(); replacement.release();
  }
});


it("does not mistake non-shell output for a capture outside the boot context", () => {
  expect(shimFiles.has("/non-shell/output")).toBe(false);
  expect(shimFiles.get("/non-shell/output")).toBeUndefined();
  expect(() => fs.createWriteStream("/non-shell/output")).toThrow("no live Space owner");
  expect(() => fs.createReadStream("/non-shell/output")).toThrow("no live Space owner");
});
