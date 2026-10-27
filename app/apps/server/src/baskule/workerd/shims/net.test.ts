import { describe, expect, it } from "@effect/vitest";

// @ts-expect-error plain JS shim without types
import net from "./net.js";

describe("workerd net shim", () => {
  it("refuses client connections asynchronously, like a closed port", async () => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 22 });
    socket.unref();
    socket.setTimeout(250);
    const outcome = await new Promise<string>((resolve) => {
      socket.once("connect", () => resolve("connect"));
      socket.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    });
    expect(outcome).toBe("ECONNREFUSED");
    socket.destroy();
  });

  it("still refuses servers", () => {
    expect(() => net.createServer()).toThrow(/unavailable in a space cell/);
  });
});
