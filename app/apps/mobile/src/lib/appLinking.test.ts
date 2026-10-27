import { describe, expect, it } from "vite-plus/test";
import { isConnectAppLink, shouldHandleAppLink } from "./appLinking";
import { parseConnectTarget } from "../baskule/config";
import { isMobileRouteEnabled } from "../baskule/flags";

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
  it.each(["baskule", "baskule-dev", "baskule-preview", "baskule-unknown"])(
    "rejects the retired or uninstalled %s scheme",
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
