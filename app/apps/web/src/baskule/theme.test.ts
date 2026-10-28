// baskule: the app starts on the light theme; dark is chosen explicitly (hooks/useTheme.ts).
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readThemePreference } from "../hooks/useTheme";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme default", () => {
  it("is light when no preference is stored", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });

    expect(readThemePreference()).toBe("light");
  });
});
