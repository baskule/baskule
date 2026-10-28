import { describe, expect, it } from "vite-plus/test";

import { cn, newThreadId } from "./utils";

it("creates compact URL-safe chat IDs", () => {
  expect(newThreadId()).toMatch(/^[A-Za-z0-9_-]{21}$/);
});

describe("cn", () => {
  it("keeps a background color next to a composer seam background image", () => {
    expect(cn("dark:before:bg-transparent dark:before:bg-composer-seam-below")).toBe(
      "dark:before:bg-transparent dark:before:bg-composer-seam-below",
    );
  });
});
