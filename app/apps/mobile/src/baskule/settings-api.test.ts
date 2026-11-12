import type { MemberPlugin } from "@t3tools/contracts/baskule-plugins";
import type { MyUsage } from "@t3tools/contracts/baskule-usage";
import { describe, expect, it, vi } from "vite-plus/test";

const transport = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock("expo/fetch", () => transport);

import {
  changeBaskulePassword,
  disconnectPluginServer,
  fetchMemberPlugins,
  fetchMyUsage,
  setPluginOn,
} from "./settings-api";

const session = { serverUrl: "https://front.test", token: "signed.bearer" };
const usage: MyUsage = {
  limits: [
    {
      window: "daily",
      used: { tokens: 10, costUsd: 0.1 },
      limit: { tokens: 20 },
      resetsAt: "2026-11-11T00:00:00Z",
      blocked: false,
    },
  ],
  totals: {
    today: { tokens: 10, costUsd: 0.1 },
    week: { tokens: 20, costUsd: 0.2 },
    month: { tokens: 30, costUsd: 0.3 },
  },
  daily: [{ date: "2026-11-10", turns: 1, tokens: 10, costUsd: 0.1 }],
  byModel: [{ provider: "test", model: "fake", tokens: 10, costUsd: 0.1 }],
};
const plugin: MemberPlugin = {
  id: "mail",
  displayName: "Mail",
  description: "Email",
  logo: "https://raw.githubusercontent.com/cursor/plugins/abc/mail/logo.svg",
  category: "communication",
  on: true,
  enabled: true,
  servers: [
    {
      id: "inbox",
      name: "inbox",
      connection: {
        state: "connected",
        account: "ada@example.test",
        connectedAt: "2026-11-10T08:00:00Z",
      },
    },
    { id: "calendar", name: "calendar", connection: { state: "expired" } },
    { id: "files", name: "files", connection: { state: "unavailable" } },
  ],
  skillCount: 2,
};

describe("native settings API", () => {
  it("uses the signed replacement bearer after a password change, never the raw JSON token", async () => {
    transport.fetch.mockReset().mockResolvedValueOnce(
      Response.json(
        { token: "raw-token" },
        {
          headers: { "set-auth-token": "replacement.signed" },
        },
      ),
    );
    await expect(
      changeBaskulePassword(session, {
        currentPassword: " old password ",
        newPassword: " new password ",
      }),
    ).resolves.toBe("replacement.signed");
    const [url, init] = transport.fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://front.test/auth/change-password");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer signed.bearer");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      currentPassword: " old password ",
      newPassword: " new password ",
      revokeOtherSessions: true,
    });
    transport.fetch.mockResolvedValueOnce(Response.json({ token: "raw-token" }));
    await expect(
      changeBaskulePassword(session, { currentPassword: "old", newPassword: "new" }),
    ).rejects.toMatchObject({ kind: "signed-out" });
  });

  it("decodes usage and plugin connections and rejects malformed successful responses", async () => {
    transport.fetch
      .mockReset()
      .mockResolvedValueOnce(Response.json(usage))
      .mockResolvedValueOnce(Response.json({ plugins: [plugin] }));
    await expect(fetchMyUsage(session)).resolves.toEqual(usage);
    await expect(fetchMemberPlugins(session)).resolves.toEqual([plugin]);
    expect(transport.fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://front.test/api/baskule/usage/me",
      "https://front.test/api/baskule/plugins",
    ]);
    transport.fetch.mockResolvedValueOnce(
      Response.json({ ...usage, limits: [{ ...usage.limits[0], blocked: "false" }] }),
    );
    await expect(fetchMyUsage(session)).rejects.toMatchObject({ kind: "server" });
    transport.fetch.mockResolvedValueOnce(
      Response.json({
        plugins: [{ ...plugin, servers: [{ id: "x", name: "x", connection: { state: "ready" } }] }],
      }),
    );
    await expect(fetchMemberPlugins(session)).rejects.toMatchObject({ kind: "server" });
    transport.fetch.mockResolvedValueOnce(new Response("not json"));
    await expect(fetchMyUsage(session)).rejects.toMatchObject({ kind: "server" });
  });

  it("switches a plugin and disconnects one server by encoded id", async () => {
    transport.fetch.mockReset().mockImplementation(async () => Response.json({ ok: true }));
    await setPluginOn(session, { pluginId: "plugin/name", on: false });
    await disconnectPluginServer(session, { pluginId: "plugin/name", serverId: "a?b" });
    expect(
      transport.fetch.mock.calls.map(([url, init]) => ({
        url,
        method: init?.method,
        body: init?.body,
      })),
    ).toEqual([
      {
        url: "https://front.test/api/baskule/plugins/plugin%2Fname",
        method: "PUT",
        body: JSON.stringify({ on: false }),
      },
      {
        url: "https://front.test/api/baskule/plugins/plugin%2Fname/servers/a%3Fb/connection",
        method: "DELETE",
        body: undefined,
      },
    ]);
    for (const [, init] of transport.fetch.mock.calls) {
      expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer signed.bearer");
    }
  });

  it.each([
    [401, {}, "signed-out", undefined],
    [429, {}, "rate-limited", undefined],
    [400, { code: "INVALID_PASSWORD" }, "invalid-credentials", "INVALID_PASSWORD"],
    [404, { error: "plugin_not_found" }, "server", "plugin_not_found"],
    [500, { error: "unknown_failure" }, "server", "unknown_failure"],
  ])("reports HTTP %i errors without leaking server messages", async (status, body, kind, code) => {
    transport.fetch
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({ ...body, message: "private server detail" }, { status }),
      );
    const error = await fetchMemberPlugins(session).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status, kind, code });
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) expect(error.message).not.toContain("private server detail");
  });

  it("reports network failures and permits anonymous usage without an empty bearer", async () => {
    transport.fetch.mockReset().mockRejectedValueOnce(new TypeError("Network request failed"));
    await expect(fetchMyUsage(session)).rejects.toMatchObject({ kind: "network" });
    transport.fetch.mockResolvedValueOnce(Response.json(usage));
    await fetchMyUsage({ ...session, token: "" });
    expect(new Headers(transport.fetch.mock.calls[1]?.[1]?.headers).has("authorization")).toBe(
      false,
    );
  });
});
