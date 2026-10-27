// baskule: logic behind the Baskule views (tokens from links, passwords, downloads, health).
import { describe, expect, it } from "vite-plus/test";

import { otherAuthor } from "./authorship";
import { describeDownload } from "./api";
import { healthSummary } from "./admin/general/OverviewPage";
import { orderDownloads, visitorPlatform } from "./views/DownloadsView";
import { passwordProblem, tokenFromHash } from "./views/InvitationView";

describe("Baskule views", () => {
  it("reads the token from the link's fragment", () => {
    expect(tokenFromHash("#token=abc123")).toBe("abc123");
    expect(tokenFromHash("token=abc123")).toBe("abc123");
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#other=1")).toBeNull();
  });

  it("checks new passwords", () => {
    expect(passwordProblem("short", "")).toMatch(/at least 8/);
    expect(passwordProblem("long-enough", "different")).toMatch(/match/);
    expect(passwordProblem("long-enough", "")).toBeNull();
    expect(passwordProblem("long-enough", "long-enough")).toBeNull();
  });

  it("names other people's messages, not your own", () => {
    const alice = { id: "u-alice", name: "Alice" };
    expect(otherAuthor(alice, "u-alice")).toBeNull();
    expect(otherAuthor(alice, "u-bob")).toEqual(alice);
    expect(otherAuthor(undefined, "u-bob")).toBeNull();
  });

  it("offers the visitor's platform first", () => {
    expect(visitorPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(visitorPlatform("Mozilla/5.0 (Linux; Android 15)")).toBe("android");
    const files = [
      describeDownload({ name: "Baskule-0.2.0.apk", url: "/a" }),
      describeDownload({ name: "Baskule-0.2.0-x86_64.AppImage", url: "/b" }),
    ];
    expect(orderDownloads(files, "android")[0]?.platform).toBe("android");
    expect(orderDownloads(files, null)[0]?.platform).toBe("linux");
  });

  it("sums space health", () => {
    const status = (awake: boolean, computer: "running" | "stopped" | "error", activeRuns = 0) => ({
      status: { awake, sockets: 0, activeRuns, computer, error: null },
    });
    expect(
      healthSummary([
        status(true, "running", 2),
        status(false, "stopped"),
        status(true, "error"),
        { status: null },
      ]),
    ).toEqual({
      awake: 2,
      computers: 1,
      runs: 2,
      problems: 1,
    });
  });
});
