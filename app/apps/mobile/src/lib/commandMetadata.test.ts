import { expect, it, vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({
  getRandomBytes: (size: number) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  randomUUID: () => globalThis.crypto.randomUUID(),
}));

import { makeTurnCommandMetadata } from "./commandMetadata";

it("creates mobile chats with compact URL-safe IDs", () => {
  expect(makeTurnCommandMetadata().threadId).toMatch(/^[A-Za-z0-9_-]{21}$/);
});
