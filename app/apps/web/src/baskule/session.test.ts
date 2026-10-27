// baskule: sign-in redirects and space ordering.
import { describe, expect, it } from "vite-plus/test";

import { isBaskulePublicPath, loginPathFor, orderSpaces, safeNextPath } from "./session";

describe("Baskule session helpers", () => {
  it("knows the pages that need no session", () => {
    expect(isBaskulePublicPath("/login")).toBe(true);
    expect(isBaskulePublicPath("/invite")).toBe(true);
    expect(isBaskulePublicPath("/reset-password")).toBe(true);
    expect(isBaskulePublicPath("/admin")).toBe(false);
  });

  it("returns to the page that needed a sign-in", () => {
    expect(loginPathFor({ pathname: "/" })).toBe("/login");
    expect(loginPathFor({ pathname: "/admin/people/users", search: "?q=ada" })).toBe(
      "/login?next=%2Fadmin%2Fpeople%2Fusers%3Fq%3Dada",
    );
    expect(loginPathFor({ pathname: "/login" })).toBe("/login");
  });

  it("follows only same-app paths after sign-in", () => {
    expect(safeNextPath("/admin/spaces/team?q=acme")).toBe("/admin/spaces/team?q=acme");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/\n/evil.example")).toBe("/");
    expect(safeNextPath("/s/space/api")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });

  it("puts the personal space first, then team spaces by name", () => {
    const space = (id: string, name: string, kind: "personal" | "team") =>
      ({ id, name, kind, role: "member", base: `/s/${id}` }) as const;
    expect(
      orderSpaces([
        space("b", "Zeta", "team"),
        space("p", "Personal", "personal"),
        space("a", "Acme", "team"),
      ]).map((entry) => entry.name),
    ).toEqual(["Personal", "Acme", "Zeta"]);
  });
});

describe("revoked space sockets", () => {
  it("recognises space socket URLs only", async () => {
    const { isSpaceSocketUrl } = await import("./session");
    expect(isSpaceSocketUrl("ws://h:1/s/abc123/ws?orchestrationProtocol=2")).toBe(true);
    expect(isSpaceSocketUrl("ws://h:1/s/abc123/ws")).toBe(true);
    expect(isSpaceSocketUrl("ws://h:1/s/abc123/wsx")).toBe(false);
    expect(isSpaceSocketUrl("ws://h:1/ws")).toBe(false);
  });

  it("calls back when a space socket is closed with the revocation code", async () => {
    const { REVOKED_CLOSE_CODE, watchRevokedSpaceSockets } = await import("./session");
    class FakeSocket extends EventTarget {
      constructor(readonly url: string | URL) {
        super();
      }
    }
    const original = globalThis.window;
    const fakeWindow = { WebSocket: FakeSocket } as unknown as Window & typeof globalThis;
    (globalThis as { window: unknown }).window = fakeWindow;
    try {
      let revoked = 0;
      watchRevokedSpaceSockets(() => revoked++);
      const Watched = fakeWindow.WebSocket as unknown as new (url: string) => EventTarget;
      const close = (url: string, code: number) => {
        const socket = new Watched(url);
        socket.dispatchEvent(Object.assign(new Event("close"), { code }));
      };
      close("ws://h/s/acme/ws?orchestrationProtocol=2", 1006);
      close("ws://h/other", REVOKED_CLOSE_CODE);
      expect(revoked).toBe(0);
      close("ws://h/s/acme/ws?orchestrationProtocol=2", REVOKED_CLOSE_CODE);
      expect(revoked).toBe(1);
      // Idempotent: a second install does not wrap twice.
      watchRevokedSpaceSockets(() => revoked++);
      close("ws://h/s/acme/ws", REVOKED_CLOSE_CODE);
      expect(revoked).toBe(2);
    } finally {
      (globalThis as { window: unknown }).window = original;
    }
  });
});
