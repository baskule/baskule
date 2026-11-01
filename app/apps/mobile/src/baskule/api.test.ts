import { describe, expect, it } from "vite-plus/test";

import { BaskuleApiError, fetchInstance, fetchMe, redeemConnectCode, signIn } from "./api";

const SERVER = "http://100.64.0.42:47090";

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("signIn", () => {
  it("posts the credentials and returns the signed bearer from set-auth-token", async () => {
    const { calls, fetchFn } = fakeFetch(
      () => new Response("{}", { status: 200, headers: { "set-auth-token": "tok.sig" } }),
    );
    await expect(signIn(SERVER, " a@b.c ", "pw", fetchFn)).resolves.toBe("tok.sig");
    expect(calls[0]?.url).toBe(`${SERVER}/auth/sign-in/email`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ email: "a@b.c", password: "pw" });
    expect(calls[0]?.init.credentials).toBe("omit");
  });

  it("names the failure", async () => {
    const status = async (code: number) =>
      signIn(SERVER, "a@b.c", "pw", fakeFetch(() => new Response("{}", { status: code })).fetchFn)
        .then(() => null)
        .catch((error: BaskuleApiError) => error.kind);
    expect(await status(401)).toBe("invalid-credentials");
    expect(await status(403)).toBe("deactivated");
    expect(await status(429)).toBe("rate-limited");
    expect(await status(500)).toBe("server");
    const offline = (async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;
    expect(await signIn(SERVER, "a", "b", offline).catch((e: BaskuleApiError) => e.kind)).toBe(
      "network",
    );
  });
});

describe("fetchMe", () => {
  it("sends the bearer and treats 401 as signed out", async () => {
    const me = { user: { id: "u" }, organization: { id: "o", name: "Org" }, spaces: [] };
    const ok = fakeFetch(() => Response.json(me));
    await expect(fetchMe(SERVER, "tok", ok.fetchFn)).resolves.toEqual(me);
    expect(new Headers(ok.calls[0]?.init.headers).get("authorization")).toBe("Bearer tok");
    const gone = fakeFetch(() => new Response("{}", { status: 401 }));
    await expect(fetchMe(SERVER, "tok", gone.fetchFn)).rejects.toMatchObject({
      kind: "signed-out",
    });
  });
});

describe("connecting with a link", () => {
  it("checks the discovery document", async () => {
    const authentication = { mode: "authenticated", password: true, providers: [] };
    const ok = fakeFetch(() => Response.json({ product: "baskule", name: "Acme", authentication }));
    await expect(fetchInstance(SERVER, ok.fetchFn)).resolves.toEqual({
      name: "Acme",
      authentication,
    });
    expect(ok.calls[0]?.url).toBe(`${SERVER}/.well-known/baskule`);
    const other = fakeFetch(() => new Response("<html>", { status: 200 })).fetchFn;
    await expect(fetchInstance(SERVER, other)).rejects.toThrow(/not a Baskule server/);
  });

  it("redeems the code for a bearer, and names a used or expired code", async () => {
    const { calls, fetchFn } = fakeFetch(
      () => new Response("{}", { status: 200, headers: { "set-auth-token": "tok.sig" } }),
    );
    await expect(redeemConnectCode(SERVER, "c0de", fetchFn)).resolves.toBe("tok.sig");
    expect(calls[0]?.url).toBe(`${SERVER}/auth/connect/redeem`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: "c0de" });
    const used = fakeFetch(() => new Response("{}", { status: 404 })).fetchFn;
    expect(
      await redeemConnectCode(SERVER, "c0de", used).catch((e: BaskuleApiError) => e.kind),
    ).toBe("invalid-credentials");
  });
});
