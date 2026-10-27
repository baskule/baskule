// baskule: copy rewrite, flag on.
import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("says chat instead of thread when the Baskule UI is on", async () => {
  vi.resetModules();
  vi.stubEnv("VITE_BASKULE_UI", "1");
  const { baskuleCopy } = await import("./copy");
  expect(baskuleCopy('Delete thread "Beta"?')).toBe('Delete chat "Beta"?');
  expect(baskuleCopy("Thread archived. No threads yet.")).toBe("Chat archived. No chats yet.");
  expect(baskuleCopy("threadId stays")).toBe("threadId stays");
});
