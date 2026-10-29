// baskule: switches of the hosted multi-user build (flags on).
import { afterEach, expect, it, vi } from "vite-plus/test";

import type { BaskuleMe } from "./api";

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

const member: BaskuleMe = {
  authentication: { mode: "authenticated", password: true, providers: [] },
  user: { id: "u1", name: "Ada", email: "ada@example.test", role: "member" },
  organizationName: null,
  spaces: [{ id: "s1", name: "Personal", kind: "personal", role: "owner", base: "/s/s1" }],
  canCreateSpaces: false,
  voiceInput: false,
};

it("lists the person's settings sections, scheduled tasks first", async () => {
  const { settingsPages } = await loadHosted();
  const paths = (me: BaskuleMe | null) =>
    settingsPages.baskuleSettingsSections(me).map((section) => section.path);
  expect(paths(member)).toEqual([
    "/settings/scheduled-tasks",
    "/settings/usage",
    "/settings/plugins",
    "/settings/desktop",
    "/settings/password",
    "/settings/general",
    "/settings/archived",
  ]);
  const owner: BaskuleMe = {
    ...member,
    authentication: { mode: "authenticated", password: false, providers: [] },
    spaces: [
      ...member.spaces,
      { id: "s2", name: "Acme", kind: "team", role: "owner", base: "/s/s2" },
    ],
  };
  expect(paths(owner)).toContain("/settings/spaces");
  expect(paths(owner)).not.toContain("/settings/password");
  expect(settingsPages.firstBaskuleSettingsPath()).toBe("/settings/scheduled-tasks");
  expect(settingsPages.isBaskuleSettingsPage("/settings/password")).toBe(true);
  expect(settingsPages.isBaskuleSettingsPage("/settings/account")).toBe(false);
  expect(settingsPages.isBaskuleSettingsPage("/settings/appearance")).toBe(false);
  expect(settingsPages.baskuleSettingsSection("/settings/general")?.label).toBe(
    "Language & appearance",
  );
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
