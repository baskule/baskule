// baskule: the Baskule UI ignores shortcuts for hidden features (review M1). Runs with the flag
// on; the rest of the unit suite runs with it off (review M6).
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

async function loadWithFlag(value: string) {
  vi.resetModules();
  vi.stubEnv("VITE_BASKULE_UI", value);
  const [{ resolveShortcutCommand }, { mergeWithDefaultKeybindings }] = await Promise.all([
    import("../keybindings"),
    import("@t3tools/shared/keybindings"),
  ]);
  return { resolveShortcutCommand, keybindings: mergeWithDefaultKeybindings([]) };
}

const ctrl = (key: string) =>
  ({ key, metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }) as never;
const options = { platform: "Linux" };

describe("Baskule keybinding allowlist", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // resetModules includes cold Vite transforms; concurrent CI builds exceeded the default 15 seconds.
  it("drops the terminal, command palette and diff shortcuts, keeps new chat", async () => {
    const { resolveShortcutCommand, keybindings } = await loadWithFlag("1");
    expect(resolveShortcutCommand(ctrl("j"), keybindings, options)).toBeNull();
    expect(resolveShortcutCommand(ctrl("k"), keybindings, options)).toBeNull();
    expect(resolveShortcutCommand(ctrl("d"), keybindings, options)).toBeNull();
    expect(resolveShortcutCommand(ctrl("n"), keybindings, options)).toBe("chat.new");
    expect(resolveShortcutCommand(ctrl("b"), keybindings, options)).toBe("sidebar.toggle");
  });

  it("keeps upstream shortcuts with the flag off", async () => {
    const { resolveShortcutCommand, keybindings } = await loadWithFlag("0");
    expect(resolveShortcutCommand(ctrl("j"), keybindings, options)).toBe("terminal.toggle");
    expect(resolveShortcutCommand(ctrl("k"), keybindings, options)).toBe("commandPalette.toggle");
  });
});
