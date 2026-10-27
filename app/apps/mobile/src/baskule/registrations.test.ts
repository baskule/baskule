import { describe, expect, it } from "vite-plus/test";

import { fetchSpaceEnvironmentId, spaceRegistration } from "./registrations";

const SERVER = "http://100.64.0.42:47090";
const ACME = { id: "acme1", name: "Acme", kind: "team", role: "owner", base: "/s/acme1" } as const;

describe("spaceRegistration", () => {
  it("registers anonymous spaces without a session credential", async () => {
    const registration = spaceRegistration({
      serverUrl: SERVER,
      token: "",
      space: ACME,
      environmentId: "env-acme",
    });
    expect(registration.profile.authorization).toBe("anonymous");
    const fetchFn = (async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      return Response.json({ environmentId: "env-acme" });
    }) as unknown as typeof fetch;
    await expect(fetchSpaceEnvironmentId(SERVER, "", ACME, fetchFn)).resolves.toBe("env-acme");
  });
  it("registers the space as a front-session environment under its base path", () => {
    const registration = spaceRegistration({
      serverUrl: SERVER,
      token: "tok",
      space: ACME,
      environmentId: "env-acme",
    });
    expect(registration.target.label).toBe("Acme");
    expect(registration.target.environmentId).toBe("env-acme");
    expect(registration.profile).toMatchObject({
      connectionId: registration.target.connectionId,
      httpBaseUrl: `${SERVER}/s/acme1/`,
      wsBaseUrl: "ws://100.64.0.42:47090/s/acme1/",
      authorization: "front-session",
    });
    expect(registration.credential.token).toBe("tok");
  });
});

describe("fetchSpaceEnvironmentId", () => {
  it("reads the descriptor with the session token", async () => {
    let seen: { url: string; authorization: string | null } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, authorization: new Headers(init.headers).get("authorization") };
      return Response.json({ environmentId: "env-acme" });
    }) as unknown as typeof fetch;
    await expect(fetchSpaceEnvironmentId(SERVER, "tok", ACME, fetchFn)).resolves.toBe("env-acme");
    expect(seen).toEqual({
      url: `${SERVER}/s/acme1/.well-known/t3/environment`,
      authorization: "Bearer tok",
    });
    const down = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    await expect(fetchSpaceEnvironmentId(SERVER, "tok", ACME, down)).resolves.toBeNull();
  });
});
