import { describe, expect, it } from "vite-plus/test";

import {
  createAdvertisedEndpoint,
  deriveWsBaseUrl,
  environmentEndpointUrl,
  environmentSocketUrl,
  normalizeHttpBaseUrl,
  resolveEnvironmentRelativeUrl,
} from "./endpoint.ts";

const coreProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
} as const;

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });

  it("keeps a base path, with a trailing slash", () => {
    expect(normalizeHttpBaseUrl("https://example.com/s/space?x=1#hash")).toBe(
      "https://example.com/s/space/",
    );
    expect(deriveWsBaseUrl("https://example.com/s/space/")).toBe("wss://example.com/s/space/");
  });
});

describe("base-path endpoints", () => {
  it("resolves assets under a bundled desktop scheme", () => {
    expect(resolveEnvironmentRelativeUrl("baskule://app/s/a1/", "/api/assets?id=1")).toBe(
      "baskule://app/s/a1/api/assets?id=1",
    );
    expect(resolveEnvironmentRelativeUrl("baskule://app/s/a1/", "/s/a1/api/assets?id=1")).toBe(
      "baskule://app/s/a1/api/assets?id=1",
    );
  });

  it("joins endpoint paths under the base path", () => {
    expect(environmentEndpointUrl("https://example.com/", "/api/auth/session")).toBe(
      "https://example.com/api/auth/session",
    );
    expect(environmentEndpointUrl("https://example.com/s/a1/", "/.well-known/t3/environment")).toBe(
      "https://example.com/s/a1/.well-known/t3/environment",
    );
    expect(environmentEndpointUrl("https://example.com/s/a1?x=1", "/oauth/token")).toBe(
      "https://example.com/s/a1/oauth/token",
    );
  });

  it("puts the socket at <base>/ws and keeps an explicit socket path", () => {
    expect(environmentSocketUrl("ws://127.0.0.1:3773").toString()).toBe("ws://127.0.0.1:3773/ws");
    expect(environmentSocketUrl("wss://example.com/s/a1/").toString()).toBe(
      "wss://example.com/s/a1/ws",
    );
    expect(environmentSocketUrl("wss://example.com/custom-socket").toString()).toBe(
      "wss://example.com/custom-socket",
    );
  });

  it("resolves server-returned URLs under the base path", () => {
    const base = "https://example.com/s/a1/";
    expect(resolveEnvironmentRelativeUrl(base, "/api/assets/x?sig=1")).toBe(
      "https://example.com/s/a1/api/assets/x?sig=1",
    );
    // A base-path-aware server may already prefix it.
    expect(resolveEnvironmentRelativeUrl(base, "/s/a1/api/assets/x")).toBe(
      "https://example.com/s/a1/api/assets/x",
    );
    expect(resolveEnvironmentRelativeUrl(base, "api/assets/x")).toBe(
      "https://example.com/s/a1/api/assets/x",
    );
    expect(resolveEnvironmentRelativeUrl(base, "https://cdn.example.net/a.png")).toBe(
      "https://cdn.example.net/a.png",
    );
    expect(resolveEnvironmentRelativeUrl("http://127.0.0.1:3773/", "/api/assets/x")).toBe(
      "http://127.0.0.1:3773/api/assets/x",
    );
  });
});
