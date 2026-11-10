// baskule: sign-in redirects and space ordering.
import { describe, expect, it, vi } from "vite-plus/test";

import { BaskuleApiError, baskuleApi, type BaskuleMe } from "./api";
import {
  __setBaskuleMeForTests,
  ensureSignedInAs,
  isBaskulePublicPath,
  loginPathFor,
  orderSpaces,
  readBaskuleMe,
  refreshBaskuleMe,
  refreshBaskuleMeAfterMutation,
  safeNextPath,
} from "./session";

const sessionWithSpaces = (spaces: BaskuleMe["spaces"]): BaskuleMe => ({
  authentication: { mode: "authenticated", password: true, providers: [] },
  user: { id: "ada", name: "Ada", email: "ada@example.com", role: "member" },
  organizationName: null,
  spaces,
  canCreateSpaces: false,
  voiceInput: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("session revalidation after a mutation", () => {
  it("does not reuse a pre-mutation membership response and coalesces invalidations", async () => {
    __setBaskuleMeForTests(null);
    using cleanup = new DisposableStack();
    cleanup.defer(() => __setBaskuleMeForTests(null));
    const before = sessionWithSpaces([
      { id: "team", name: "Team", kind: "team", role: "member", base: "/s/team" },
    ]);
    const after = sessionWithSpaces([]);
    const pending = deferred<BaskuleMe>();
    using me = vi
      .spyOn(baskuleApi, "me")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(after);

    const refresh = refreshBaskuleMe();
    const first = refreshBaskuleMeAfterMutation();
    const second = refreshBaskuleMeAfterMutation();
    pending.resolve(before);

    await expect(refresh).resolves.toEqual(before);
    await expect(Promise.all([first, second])).resolves.toEqual([after, after]);
    expect(readBaskuleMe()).toEqual(after);
    expect(me).toHaveBeenCalledTimes(2);
  });

  it("still reads current membership when the older request fails", async () => {
    __setBaskuleMeForTests(null);
    using cleanup = new DisposableStack();
    cleanup.defer(() => __setBaskuleMeForTests(null));
    const after = sessionWithSpaces([]);
    const pending = deferred<BaskuleMe>();
    using me = vi
      .spyOn(baskuleApi, "me")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(after);

    const refresh = expect(refreshBaskuleMe()).rejects.toThrow("offline");
    const revalidation = refreshBaskuleMeAfterMutation();
    pending.reject(new Error("offline"));

    await refresh;
    await expect(revalidation).resolves.toEqual(after);
    expect(readBaskuleMe()).toEqual(after);
    expect(me).toHaveBeenCalledTimes(2);
  });

  it("revalidates again for a mutation made while the follow-up request is pending", async () => {
    __setBaskuleMeForTests(null);
    using cleanup = new DisposableStack();
    cleanup.defer(() => __setBaskuleMeForTests(null));
    const before = sessionWithSpaces([]);
    const afterFirst = { ...before, canCreateSpaces: true };
    const afterSecond = { ...before, voiceInput: true };
    const initial = deferred<BaskuleMe>();
    const followUp = deferred<BaskuleMe>();
    const followUpStarted = deferred<void>();
    using me = vi
      .spyOn(baskuleApi, "me")
      .mockReturnValueOnce(initial.promise)
      .mockImplementationOnce(() => {
        followUpStarted.resolve();
        return followUp.promise;
      })
      .mockResolvedValue(afterSecond);

    const refresh = refreshBaskuleMe();
    const first = refreshBaskuleMeAfterMutation();
    initial.resolve(before);
    await followUpStarted.promise;
    const second = refreshBaskuleMeAfterMutation();
    followUp.resolve(afterFirst);

    await expect(refresh).resolves.toEqual(before);
    await expect(first).resolves.toEqual(afterFirst);
    await expect(second).resolves.toEqual(afterSecond);
    expect(readBaskuleMe()).toEqual(afterSecond);
    expect(me).toHaveBeenCalledTimes(3);
  });
});

describe("Baskule session helpers", () => {
  it("knows the pages that need no session", () => {
    expect(isBaskulePublicPath("/login")).toBe(true);
    expect(isBaskulePublicPath("/invite")).toBe(true);
    expect(isBaskulePublicPath("/reset-password")).toBe(true);
    expect(isBaskulePublicPath("/setup")).toBe(true);
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

  it("keeps a session only when it belongs to the expected person, otherwise signs in", async () => {
    const credentials = { email: "ada@example.com", password: "correct horse" };
    const meAs = (id: string): BaskuleMe => ({
      authentication: { mode: "authenticated", password: true, providers: [] },
      user: { id, name: id, email: `${id}@example.com`, role: "admin" },
      organizationName: null,
      spaces: [],
      canCreateSpaces: true,
      voiceInput: false,
    });
    using me = vi.spyOn(baskuleApi, "me").mockResolvedValue(meAs("ada"));
    using signIn = vi.spyOn(baskuleApi, "signIn").mockResolvedValue({});
    await expect(ensureSignedInAs("ada", credentials)).resolves.toBe(true);
    expect(signIn).not.toHaveBeenCalled();

    // Another tab replaced the session after the request set it.
    me.mockResolvedValue(meAs("grace"));
    await expect(ensureSignedInAs("ada", credentials)).resolves.toBe(true);
    expect(signIn).toHaveBeenLastCalledWith(credentials);

    me.mockRejectedValue(new BaskuleApiError(401, "You are signed out.", null));
    signIn.mockClear();
    await expect(ensureSignedInAs("ada", credentials)).resolves.toBe(true);
    expect(signIn).toHaveBeenCalledWith(credentials);

    signIn.mockRejectedValue(new BaskuleApiError(401, "Invalid email or password.", null));
    await expect(ensureSignedInAs("ada", credentials)).resolves.toBe(false);
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
