import { describe, expect, it } from "vite-plus/test";
import { parseConnectTarget } from "../baskule/config";
import { isMobileRouteEnabled } from "../baskule/flags";

import type { NavigationState } from "@react-navigation/native";
import {
  isConnectAppLink,
  findLinkedRoute,
  findStackRoute,
  restoreDraftLinkState,
  shouldHandleAppLink,
  updateLinkedRoute,
} from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each(["t3code://", "t3code:///", "t3code-dev://", "t3code-preview://"])(
    "ignores scheme-only URL %s",
    (url) => {
      expect(shouldHandleAppLink(url, true)).toBe(false);
    },
  );

  it("leaves Baskule connection links to the sign-in screen", () => {
    expect(
      shouldHandleAppLink("baskule://connect?server=https%3A%2F%2Fos.example&code=x", false),
    ).toBe(false);
  });

  it.each([
    "t3code://threads/env-1/thread-1",
    "t3code://pair?pairingUrl=x",
    "t3code-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url, true)).toBe(true);
  });

  it.each(["t3code://expo-development-client/?url=x", "t3code://expo-sharing/anything"])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url, true)).toBe(false);
    },
  );
  it.each([
    "threads/env/thread/terminal",
    "threads/env/thread/git",
    "threads/env/thread/git/branches",
    "threads/env/thread/git-confirm",
    "threads/env/thread/review",
    "threads/env/thread/review-comment",
    "threads/env/thread/pull-requests",
    "pull-requests/env/project/repo/1",
    "threads/env/thread/devices",
  ])("rejects excluded path %s", (path) => {
    expect(shouldHandleAppLink(`baskule://${path}`)).toBe(false);
  });
  it.each([
    "threads/env/thread",
    "threads/env/thread/files",
    "threads/env/thread/browser",
    "settings/scheduled-tasks",
    "pair?pairingUrl=x",
  ])("keeps path %s", (path) => {
    expect(shouldHandleAppLink(`baskule://${path}`)).toBe(true);
    expect(shouldHandleAppLink(`t3code://${path}`)).toBe(true);
  });
  it.each([
    "PullRequest",
    "PullRequestReview",
    "ThreadTerminal",
    "GitOverview",
    "ThreadReview",
    "ThreadDevicePreview",
  ])("rejects direct navigation to %s", (route) => {
    expect(isMobileRouteEnabled(route)).toBe(false);
  });
  it.each([
    "Thread",
    "ThreadFiles",
    "ThreadBrowserPreview",
    "ScheduledTasks",
    "ScheduledTaskEditor",
  ])("keeps direct route %s", (route) => {
    expect(isMobileRouteEnabled(route)).toBe(true);
  });
});

describe("cloud-only deep links", () => {
  it.each([
    "t3code://connect-onboarding",
    "t3code-dev://connect-onboarding/?source=x",
    "t3code://settings/waitlist",
    "t3code://settings/auth",
    "exp://192.168.1.2:8081/--/settings/auth",
  ])("ignores %s without cloud config", (url) => {
    expect(shouldHandleAppLink(url, false)).toBe(false);
    expect(shouldHandleAppLink(url, true)).toBe(true);
  });

  it.each([
    "t3code://settings",
    "t3code://settings/authors",
    "t3code://pair?next=settings/auth",
    "t3code://threads/env/thread/files/scripts/connect-onboarding",
    "t3code://new/draft/files/settings/auth",
    "exp://192.168.1.2:8081/--/threads/env/thread/files/settings/waitlist",
  ])("still handles %s without cloud config", (url) => {
    expect(shouldHandleAppLink(url, false)).toBe(true);
  });
});

describe("draft deep links", () => {
  it("opens the old draft URL on the thread screen with its draft identity", () => {
    const draft = { projectId: "project-1", environmentId: "env-1", draftId: "draft-1" };
    expect(
      restoreDraftLinkState(
        { routes: [{ name: "Home" }, { name: "Thread", params: draft }] },
        "/new/draft?draftId=draft-1",
      ),
    ).toEqual({
      index: 1,
      routes: [{ name: "Home" }, { name: "Thread", params: { draft } }],
    });
  });

  it.each([
    ["environment", "NewTaskEnvironment"],
    ["branch", "NewTaskBranch"],
    ["files", "NewTaskFiles"],
    ["files/src/index.ts", "NewTaskFile"],
    ["attachments/attachment-1", "NewTaskAttachment"],
    ["settings", "NewTaskThreadSettings"],
  ])("restores a draft beneath its %s screen", (path, name) => {
    const params = { environmentId: "env-1", projectId: "project-1" };
    const target = { name, params };
    expect(
      restoreDraftLinkState({ routes: [{ name: "Home" }, target] }, `/new/draft/${path}`),
    ).toEqual({
      index: 2,
      routes: [{ name: "Home" }, { name: "Thread", params: { draft: params } }, target],
    });
  });

  it("leaves live-thread and project-selection links unchanged", () => {
    const state = { routes: [{ name: "Thread", params: { threadId: "thread-1" } }] };
    expect(restoreDraftLinkState(state, "/threads/env-1/thread-1")).toBe(state);
    expect(restoreDraftLinkState(state, "/new")).toBe(state);
    expect(restoreDraftLinkState(undefined, "/new/draft")).toBeUndefined();
  });
});

describe("nested link routes", () => {
  const settingsLink = {
    routes: [
      { name: "Home" },
      {
        name: "SettingsSheet",
        state: {
          routes: [
            { name: "Settings" },
            { name: "SettingsEnvironmentNew", params: { pairingUrl: "x", autoConnect: "1" } },
          ],
        },
      },
    ],
  };

  it("finds a route the link opens inside a nested navigator", () => {
    expect(findLinkedRoute(settingsLink, ["SettingsEnvironmentNew"])?.params).toEqual({
      pairingUrl: "x",
      autoConnect: "1",
    });
    expect(findLinkedRoute(settingsLink, ["ConnectionsNew"])).toBeUndefined();
  });

  it("rewrites a nested route without touching the rest of the state", () => {
    const next = updateLinkedRoute(settingsLink, ["SettingsEnvironmentNew"], (route) => ({
      ...route,
      params: { pairingUrl: "x" },
    }));
    expect(findLinkedRoute(next, ["SettingsEnvironmentNew"])?.params).toEqual({ pairingUrl: "x" });
    expect(next?.routes[0]).toBe(settingsLink.routes[0]);
    expect(updateLinkedRoute(settingsLink, ["ConnectionsNew"], (route) => route)).toBe(
      settingsLink,
    );
  });
});

describe("findStackRoute", () => {
  const stack = (key: string, routes: NavigationState["routes"]) =>
    ({
      key,
      index: routes.length - 1,
      routeNames: routes.map((route) => route.name),
      routes,
      stale: false,
      type: "stack",
    }) as NavigationState;

  it("finds a nested screen with the navigator that holds it", () => {
    const root = stack("root", [
      { key: "home", name: "Home" },
      {
        key: "settings",
        name: "Settings",
        state: stack("settings-stack", [{ key: "new-task", name: "NewTaskProject" }]),
      },
    ]);
    expect(findStackRoute(root, "NewTaskProject")).toEqual({
      navigatorKey: "settings-stack",
      routeKey: "new-task",
      focused: true,
    });
  });

  it("reports whether the screen is its navigator's focused route", () => {
    const covered = stack("root", [
      { key: "new-task", name: "NewTaskProject" },
      { key: "add-project", name: "AddProject" },
    ]);
    expect(findStackRoute(covered, "NewTaskProject")?.focused).toBe(false);
    expect(findStackRoute(covered, "AddProject")?.focused).toBe(true);
  });

  it("prefers the top-most screen and reports a missing one", () => {
    const root = stack("root", [
      { key: "first", name: "NewTaskProject" },
      { key: "second", name: "NewTaskProject" },
    ]);
    expect(findStackRoute(root, "NewTaskProject")?.routeKey).toBe("second");
    expect(findStackRoute(root, "Thread")).toBeUndefined();
  });
});

describe("Baskule app links", () => {
  it.each(["baskule", "baskule-dev", "baskule-preview"])(
    "receives %s connect links outside navigation",
    (scheme) => {
      const link = `${scheme}://connect?server=https%3A%2F%2Fbaskule.example&code=x`;
      expect(isConnectAppLink(link)).toBe(true);
      expect(parseConnectTarget(link)).toEqual({
        kind: "code",
        serverUrl: "https://baskule.example",
        code: "x",
      });
      expect(shouldHandleAppLink(link)).toBe(false);
      expect(shouldHandleAppLink(`${scheme}://`)).toBe(false);
    },
  );
  it.each(["other-app", "other-app-dev", "other-app-preview", "baskule-unknown"])(
    "rejects the unsupported or uninstalled %s scheme",
    (scheme) => {
      const link = `${scheme}://connect?server=https%3A%2F%2Fbaskule.example&code=x`;
      expect(isConnectAppLink(link)).toBe(false);
      expect(parseConnectTarget(link)).toBeNull();
      expect(shouldHandleAppLink(link)).toBe(false);
    },
  );
  it.each(["baskule://expo-development-client/?url=x", "baskule://expo-sharing/anything"])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );
  it.each([
    "threads/env/thread/terminal",
    "threads/env/thread/git",
    "threads/env/thread/git/branches",
    "threads/env/thread/git-confirm",
    "threads/env/thread/review",
    "threads/env/thread/review-comment",
    "threads/env/thread/pull-requests",
    "pull-requests/env/project/repo/1",
    "threads/env/thread/devices",
  ])("rejects excluded path %s", (path) => {
    expect(shouldHandleAppLink(`baskule://${path}`)).toBe(false);
  });
  it.each([
    "threads/env/thread",
    "threads/env/thread/files",
    "threads/env/thread/browser",
    "settings/scheduled-tasks",
    "pair?pairingUrl=x",
  ])("keeps path %s", (path) => {
    expect(shouldHandleAppLink(`baskule://${path}`)).toBe(true);
    expect(shouldHandleAppLink(`t3code://${path}`)).toBe(true);
  });
  it.each([
    "PullRequest",
    "PullRequestReview",
    "ThreadTerminal",
    "GitOverview",
    "ThreadReview",
    "ThreadDevicePreview",
  ])("rejects direct navigation to %s", (route) => {
    expect(isMobileRouteEnabled(route)).toBe(false);
  });
  it.each([
    "Thread",
    "ThreadFiles",
    "ThreadBrowserPreview",
    "ScheduledTasks",
    "ScheduledTaskEditor",
  ])("keeps direct route %s", (route) => {
    expect(isMobileRouteEnabled(route)).toBe(true);
  });
});
