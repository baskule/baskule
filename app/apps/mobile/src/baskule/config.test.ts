import { describe, expect, it } from "vite-plus/test";

import {
  normalizeServerUrl,
  parseConnectTarget,
  spaceConnectionId,
  spaceHttpBaseUrl,
  spaceWsBaseUrl,
} from "./config";

describe("normalizeServerUrl", () => {
  it("keeps only the origin; a bare address is https, or http on a private network", () => {
    expect(normalizeServerUrl(" http://100.64.0.42:47090/login?x=1 ")).toBe(
      "http://100.64.0.42:47090",
    );
    expect(normalizeServerUrl("100.64.0.42:47090")).toBe("http://100.64.0.42:47090");
    expect(normalizeServerUrl("https://baskule.example/")).toBe("https://baskule.example");
    expect(normalizeServerUrl("baskule.example")).toBe("https://baskule.example");
    expect(normalizeServerUrl("192.168.1.20:47090")).toBe("http://192.168.1.20:47090");
  });

  it("refuses plain http to a public host", () => {
    expect(normalizeServerUrl("http://baskule.example")).toBeNull();
  });

  it("refuses what is not an http(s) address", () => {
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("ftp://host")).toBeNull();
    expect(normalizeServerUrl("http://")).toBeNull();
  });
});

describe("space URLs", () => {
  it("puts a space's environment under its base path", () => {
    expect(spaceHttpBaseUrl("http://100.64.0.42:47090", "/s/abc")).toBe(
      "http://100.64.0.42:47090/s/abc/",
    );
    expect(spaceWsBaseUrl("https://baskule.example", "/s/abc/")).toBe(
      "wss://baskule.example/s/abc/",
    );
    expect(spaceConnectionId("http://100.64.0.42:47090", "abc")).toBe(
      "baskule:100.64.0.42:47090:abc",
    );
  });
});

describe("parseConnectTarget", () => {
  it("reads connection links, invitations and addresses", () => {
    expect(parseConnectTarget("https://os.example/link#code=abc")).toEqual({
      kind: "code",
      serverUrl: "https://os.example",
      code: "abc",
    });
    expect(
      parseConnectTarget("baskule-dev://connect?server=https%3A%2F%2Fos.example%3A8443&code=xyz"),
    ).toEqual({ kind: "code", serverUrl: "https://os.example:8443", code: "xyz" });
    expect(parseConnectTarget("https://os.example/invite#token=t0k")).toEqual({
      kind: "invitation",
      serverUrl: "https://os.example",
      url: "https://os.example/invite#token=t0k",
    });
    expect(parseConnectTarget("os.example")).toEqual({
      kind: "address",
      serverUrl: "https://os.example",
    });
  });

  it("refuses links to a public server over plain http and non-links", () => {
    expect(
      parseConnectTarget("baskule://connect?server=http%3A%2F%2Fevil.example&code=x"),
    ).toBeNull();
    expect(parseConnectTarget("hello world")).toBeNull();
    expect(parseConnectTarget("")).toBeNull();
  });
});
