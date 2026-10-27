import { describe, expect, it } from "vite-plus/test";

import {
  canHandOffToDesktopApp,
  codeFromHash,
  connectLink,
  desktopConnectLink,
  parseConnectionTarget,
  connectionTargetLink,
} from "./connect";
import { isBaskulePublicPath } from "./session";

describe("connection links", () => {
  it("round-trips the code through the link's fragment", () => {
    const link = new URL(connectLink("https://os.example", "a-b_c"));
    expect(link.origin + link.pathname).toBe("https://os.example/link");
    expect(codeFromHash(link.hash)).toBe("a-b_c");
    expect(codeFromHash("#token=x")).toBeNull();
    expect(isBaskulePublicPath(link.pathname)).toBe(true);
  });

  it("hands the server and the code to the desktop app", () => {
    const link = new URL(desktopConnectLink("https://os.example:8443", "abc"));
    expect(link.protocol).toBe("baskule:");
    expect(link.searchParams.get("server")).toBe("https://os.example:8443");
    expect(link.searchParams.get("code")).toBe("abc");
  });

  it("offers the desktop hand-off only in a desktop browser", () => {
    expect(canHandOffToDesktopApp("Mozilla/5.0 (X11; Linux x86_64) Chrome/140 Safari/537.36")).toBe(
      true,
    );
    expect(
      canHandOffToDesktopApp(
        "Mozilla/5.0 (X11; Linux x86_64) Baskule/0.3.0 Chrome/140 Electron/45.0.0",
      ),
    ).toBe(false);
    expect(
      canHandOffToDesktopApp(
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140 Mobile Safari/537.36",
      ),
    ).toBe(false);
  });
});

describe("receiving a connection", () => {
  it.each([
    ["https://baskule.example/link#code=one%20time", "https://baskule.example", "one time"],
    [
      "baskule://connect?server=https%3A%2F%2Fbaskule.example&code=one_time",
      "https://baskule.example",
      "one_time",
    ],
    [
      "baskule://connect?server=http%3A%2F%2F100.64.0.42%3A47090",
      "http://100.64.0.42:47090",
      null,
    ],
    [" http://192.168.1.2:8080/ ", "http://192.168.1.2:8080", null],
    ["baskule.example:8443", "https://baskule.example:8443", null],
  ])("reviews %s as a server and optional one-time code", (input, origin, code) => {
    const target = parseConnectionTarget(input);
    expect(target).toEqual({ origin, code });
    expect(parseConnectionTarget(connectionTargetLink(target))).toEqual(target);
  });

  it.each([
    "",
    "javascript:alert(1)",
    "file:///tmp/link",
    "baskule://connect?server=https://baskule.example",
    "baskule://app",
    "baskule://connect?server=baskule://connect",
    "http://public.example",
    "http://192.169.1.2",
    "https://user:password@baskule.example",
    "https://baskule.example/?token=bearer",
    "https://baskule.example/#token=bearer",
    "https://baskule.example/link?code=one-time",
    "https://baskule.example/link#token=bearer",
    "https://baskule.example/link#code=a&code=b",
    "https://baskule.example/other#code=a",
    "baskule://connect?server=https://baskule.example&token=bearer",
    "baskule://connect?server=https://baskule.example/path&code=a",
    "baskule://connect?server=https://baskule.example&server=https://other.example",
  ])("rejects unsupported or credential-bearing QR content %s", (input) => {
    expect(() => parseConnectionTarget(input)).toThrow();
  });
});
