import { describe, expect, it } from "vitest";
import { recheckSockets } from "../../src/shared/recheck";

describe("recheckSockets (60 s backstop for SpaceCell)", () => {
  it("asks ControlCell once per (user, session) and closes the sockets that are no longer valid", async () => {
    const seen: { url: string; internal: string | null; body: any }[] = [];
    const control = {
      getByName: (name: string) => ({
        fetch: async (req: Request) => {
          expect(name).toBe("control");
          seen.push({ url: req.url, internal: req.headers.get("x-baskule-internal"), body: await req.json() });
          return Response.json({ valid: ["s1"] });
        },
      }),
    };
    const closed: string[] = [];
    const sock = (userId: string, sessionId: string, tag: string) => ({ userId, sessionId, close: (c: number) => closed.push(`${tag}:${c}`) });
    const r = await recheckSockets(control, "sp1", [sock("u1", "s1", "a"), sock("u1", "s1", "b"), sock("u2", "s2", "c")]);
    expect(r).toEqual({ checked: 3, closed: 1 });
    expect(closed).toEqual(["c:4401"]);
    expect(seen).toEqual([{ url: "http://control/_baskule/check", internal: "1", body: { spaceId: "sp1", sessions: [{ userId: "u1", sessionId: "s1" }, { userId: "u2", sessionId: "s2" }] } }]);
  });

  it("keeps sockets when ControlCell fails (the Worker still checks every new request)", async () => {
    const control = { getByName: () => ({ fetch: async () => new Response("x", { status: 503 }) }) };
    const closed: number[] = [];
    await expect(recheckSockets(control, "sp", [{ userId: "u", sessionId: "s", close: (c) => closed.push(c) }])).rejects.toThrow(/503/);
    expect(closed).toEqual([]);
    expect(await recheckSockets(control, "sp", [])).toEqual({ checked: 0, closed: 0 });
  });
});
