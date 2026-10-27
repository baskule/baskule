// baskule: switches of the hosted multi-user build (flags on).
import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadHosted() {
  vi.resetModules();
  vi.stubEnv("VITE_BASKULE_UI", "1");
  vi.stubEnv("VITE_BASKULE_HOSTED", "1");
  return {
    threadMenu: await import("./threadMenu"),
    settingsPages: await import("./settingsPages"),
    rightPanel: await import("./rightPanel"),
    copy: await import("./copy"),
  };
}

it("offers pin, snooze and unread in the chat menu", async () => {
  const { threadMenu } = await loadHosted();
  const items = threadMenu.baskuleThreadMenuItems([
    { id: "new-thread-on-branch", label: "New thread on main" },
    { id: "pin", label: "Pin thread" },
    { id: "settle", label: "Settle thread" },
    { id: "snooze", label: "Snooze" },
    { id: "rename", label: "Rename thread" },
    { id: "mark-unread", label: "Mark unread" },
    { id: "copy", label: "Copy" },
    { id: "archive", label: "Archive thread" },
    { id: "delete", label: "Delete thread" },
  ]);
  expect(items.map((item) => item.label)).toEqual([
    "Pin",
    "Snooze",
    "Rename",
    "Mark unread",
    "Archive",
    "Delete",
  ]);
});

it("keeps archived chats and scheduled tasks among the settings pages", async () => {
  const { settingsPages } = await loadHosted();
  expect(settingsPages.isBaskuleSettingsPage("/settings/scheduled-tasks")).toBe(true);
  expect(settingsPages.isBaskuleSettingsPage("/settings/archived")).toBe(true);
  expect(settingsPages.isBaskuleSettingsPage("/settings/appearance")).toBe(false);
  expect(settingsPages.isBaskuleSettingsPage("/settings/general")).toBe(true);
  expect(settingsPages.baskuleSettingsTitle("/settings/general")).toBe("Settings");
  expect(settingsPages.baskuleSettingsTitle("/settings/scheduled-tasks")).toBe("Scheduled tasks");
});

it("shows the shared browser next to files", async () => {
  const { rightPanel } = await loadHosted();
  const labels = rightPanel
    .baskuleSurfaceActions([
      { label: "Browser" },
      { label: "Terminal" },
      { label: "Files" },
      { label: "Diff" },
    ])
    .map((action) => action.label);
  expect(labels).toEqual(["Browser", "Files"]);
});

it("names spaces in connection banners", async () => {
  const { copy } = await loadHosted();
  expect(copy.baskuleHostCopy("T3 Code on Acme did not answer")).toBe("Acme did not answer");
});

it("keeps 0.1's reduced menu without the hosted flag", async () => {
  vi.resetModules();
  vi.stubEnv("VITE_BASKULE_UI", "1");
  const { baskuleThreadMenuItems } = await import("./threadMenu");
  expect(
    baskuleThreadMenuItems([
      { id: "pin", label: "Pin thread" },
      { id: "rename", label: "Rename thread" },
    ]).map((item) => item.label),
  ).toEqual(["Rename"]);
});
