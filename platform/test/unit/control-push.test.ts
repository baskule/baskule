import { describe, expect, it, vi } from "vitest";
import {
  asAdmin,
  call,
  makeService,
  personalSpaceOf,
  signIn,
  createUser,
  ADMIN,
  request,
} from "../support/harness";
import { Push } from "../../src/control/push";
import type { PushNotification } from "../../../app/packages/contracts/src/baskulePush";

const deviceId = "0123456789abcdef0123456789abcdef";
const registration = {
  platform: "android",
  appId: "dev.test",
  token: "fcm-token",
  preferences: {
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};
const credentials = {
  apns: null,
  fcm: {
    appId: "dev.test",
    projectId: "project",
    clientEmail: "test@test.example",
    privateKey: "test-only-key",
  },
};
async function setup() {
  const h = await makeService();
  const a = await asAdmin(h);
  expect(
    (await call(h, "PUT", "/api/baskule/admin/push", { creds: a.creds, body: credentials }))
      .status,
  ).toBe(200);
  const put = (body = registration, creds = a.creds) =>
    call(h, "PUT", `/api/baskule/push/devices/${deviceId}`, { creds, body });
  const spaceId = personalSpaceOf(h, a.userId);
  const n: PushNotification = {
    eventId: "push:completion:run1",
    threadId: "thread1",
    userId: a.userId,
    kind: "completion",
    title: "Agent finished",
    body: "Chat",
    expiresAt: Date.now() + 300000,
  };
  return { h, a, put, spaceId, n };
}

describe("Baskule background push", () => {
  it("authenticates registrations, derives ownership, validates identifiers and exposes no credentials", async () => {
    const { h, a, put } = await setup();
    expect((await put(registration, {})).status).toBe(401);
    expect((await put({ ...registration, appId: "wrong.app" })).status).toBe(409);
    expect((await put({ ...registration, platform: "ios" })).status).toBe(400);
    const first = await call(h, "PUT", `/api/baskule/push/devices/${deviceId}`, {
      creds: a.creds,
      body: { ...registration, userId: "forged", sessionId: "forged" },
    });
    expect(first.status).toBe(200);
    expect(h.storage.sql.exec("select user_id,session_id from push_device").toArray()).toEqual([
      { user_id: a.userId, session_id: a.sessionId },
    ]);
    expect((await put()).body.tokenVersion).toBe(first.body.tokenVersion);
    const preferred = await put({
      ...registration,
      preferences: { ...registration.preferences, notifyOnInput: false },
    });
    expect(preferred.body.tokenVersion).toBe(first.body.tokenVersion);
    const rotated = await put({ ...registration, token: "rotated" });
    expect(rotated.body.tokenVersion).not.toBe(first.body.tokenVersion);
    const other = await signIn(h, ADMIN.email, ADMIN.password);
    expect((await put(registration, other.creds)).status).toBe(200);
    const view = await call(h, "GET", "/api/baskule/admin/push", { creds: a.creds });
    expect(view.body).toEqual({
      available: true,
      android: { appId: "dev.test" },
      ios: null,
      reason: null,
    });
    expect(JSON.stringify(view.body)).not.toContain("privateKey");
    expect(
      (await call(h, "DELETE", `/api/baskule/push/devices/${deviceId}`, { creds: a.creds }))
        .status,
    ).toBe(200);
    expect(h.storage.sql.exec("select id from push_device").toArray()).toHaveLength(1);
    await call(h, "DELETE", `/api/baskule/push/devices/${deviceId}`, { creds: other.creds });
    expect(h.storage.sql.exec("select id from push_device").toArray()).toEqual([]);
  });

  it("deduplicates receipts, retries provider failures, and cascades session revocation", async () => {
    const { h, a, put, spaceId, n } = await setup();
    await put();
    const send = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue("sent");
    const push = new Push(h.storage, async () => Response.json({ current: true }), true, send);
    const deliver = () =>
      push.deliver(
        request("POST", "/_baskule/push/deliver", {
          body: { spaceId, environmentId: "environment", notification: n },
        }),
      );
    await expect(deliver()).rejects.toMatchObject({ status: 503 });
    await deliver();
    await deliver();
    expect(send).toHaveBeenCalledTimes(2);
    h.storage.sql.exec("delete from session where id=?", a.sessionId).toArray();
    expect(h.storage.sql.exec("select id from push_device").toArray()).toEqual([]);
    expect(h.storage.sql.exec("select event_id from push_receipt").toArray()).toEqual([]);
  });

  it.each([
    { name: "503", response: () => new Response(null, { status: 503 }) },
    { name: "invalid JSON", response: () => new Response("not-json") },
    { name: "null", response: () => Response.json(null) },
    { name: "missing current", response: () => Response.json({}) },
    { name: "nonboolean current", response: () => Response.json({ current: "false" }) },
  ])("retries a $name state check without settling a receipt", async ({ response }) => {
    const { h, put, spaceId, n } = await setup();
    const enrollment = await put();
    const check = vi
      .fn()
      .mockImplementationOnce(response)
      .mockImplementation(async () => Response.json({ current: true }));
    const send = vi.fn(async () => "sent" as const);
    const push = new Push(h.storage, check, true, send);
    const deliver = () =>
      push.deliver(
        request("POST", "/_baskule/push/deliver", {
          body: { spaceId, environmentId: "environment", notification: n },
        }),
      );
    await expect(deliver()).rejects.toMatchObject({ status: 503 });
    expect(send).not.toHaveBeenCalled();
    expect(h.storage.sql.exec("select event_id from push_receipt").toArray()).toEqual([]);
    expect((await deliver()).status).toBe(200);
    await deliver();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      h.storage.sql
        .exec("select space_id,event_id,device_id,token_version from push_receipt")
        .toArray(),
    ).toEqual([
      {
        space_id: spaceId,
        event_id: n.eventId,
        device_id: deviceId,
        token_version: enrollment.body.tokenVersion,
      },
    ]);
  });

  it("retries a failed state recheck after provider authorization", async () => {
    const { h, put, spaceId, n } = await setup();
    await put();
    const check = vi
      .fn()
      .mockImplementationOnce(async () => Response.json({ current: true }))
      .mockImplementationOnce(async () => new Response(null, { status: 503 }))
      .mockImplementation(async () => Response.json({ current: true }));
    const externalSend = vi.fn();
    const push = new Push(h.storage, check, true, async (input) => {
      if (!(await input.eligible())) return "skipped";
      externalSend();
      return "sent";
    });
    const deliver = () =>
      push.deliver(
        request("POST", "/_baskule/push/deliver", {
          body: { spaceId, environmentId: "environment", notification: n },
        }),
      );
    await expect(deliver()).rejects.toMatchObject({ status: 503 });
    expect(externalSend).not.toHaveBeenCalled();
    expect(h.storage.sql.exec("select event_id from push_receipt").toArray()).toEqual([]);
    expect((await deliver()).status).toBe(200);
    expect(externalSend).toHaveBeenCalledTimes(1);
    expect(h.storage.sql.exec("select event_id from push_receipt").toArray()).toEqual([
      { event_id: n.eventId },
    ]);
  });

  it.each(["membership", "ban", "expiry", "approval", "preference"])(
    "rechecks %s immediately before provider send after asynchronous authorization",
    async (mode) => {
      const { h, a, put, spaceId, n } = await setup();
      await put();
      let current = true;
      const externalSend = vi.fn();
      const push = new Push(
        h.storage,
        async () => Response.json({ current }),
        true,
        async (input) => {
          if (mode === "membership")
            h.storage.sql
              .exec("delete from space_member where space_id=? and user_id=?", spaceId, a.userId)
              .toArray();
          if (mode === "ban")
            h.storage.sql.exec("update user set banned=1 where id=?", a.userId).toArray();
          if (mode === "expiry")
            h.storage.sql.exec("update session set expires_at=0 where id=?", a.sessionId).toArray();
          if (mode === "approval") current = false;
          if (mode === "preference")
            await put({
              ...registration,
              preferences: { ...registration.preferences, notificationsEnabled: false },
            });
          if (await input.eligible()) externalSend();
          return "skipped";
        },
      );
      await push.deliver(
        request("POST", "/_baskule/push/deliver", {
          body: { spaceId, environmentId: "environment", notification: n },
        }),
      );
      expect(externalSend).not.toHaveBeenCalled();
    },
  );

  it("ignores expired work and invalidates only the token version the provider rejected", async () => {
    const { h, put, spaceId, n } = await setup();
    await put();
    const send = vi.fn(async () => {
      await put({ ...registration, token: "rotated" });
      return "invalid" as const;
    });
    const push = new Push(h.storage, async () => Response.json({ current: true }), true, send);
    await push.deliver(
      request("POST", "/_baskule/push/deliver", {
        body: {
          spaceId,
          environmentId: "environment",
          notification: { ...n, expiresAt: Date.now() - 1 },
        },
      }),
    );
    expect(send).not.toHaveBeenCalled();
    await push.deliver(
      request("POST", "/_baskule/push/deliver", {
        body: { spaceId, environmentId: "environment", notification: n },
      }),
    );
    expect(
      h.storage.sql.exec("select registration from push_device").toArray()[0].registration,
    ).toContain("rotated");
  });

  it.each(["android", "ios"] as const)(
    "transfers a %s token after failed old cleanup, fences old sends and late cleanup, and handles reinstall",
    async (platform) => {
      const { h, a, put, spaceId, n } = await setup();
      const enrollment =
        platform === "ios"
          ? { ...registration, platform: "ios", apnsEnvironment: "sandbox", token: "a".repeat(64) }
          : registration;
      if (platform === "ios")
        await call(h, "PATCH", "/api/baskule/admin/push", {
          creds: a.creds,
          body: {
            apns: {
              appId: "dev.test",
              teamId: "TEAM",
              keyId: "KEY",
              privateKey: "test-only-key",
              environments: ["sandbox"],
            },
          },
        });
      const first = await put(enrollment);
      const bob = await createUser(h, a.creds, "push-bob@os.test", "Bob");
      const b = await signIn(h, bob.email, "user-password-1");
      const transferred = await put(enrollment, b.creds);
      expect(transferred.status).toBe(200);
      expect(transferred.body.tokenVersion).not.toBe(first.body.tokenVersion);
      const sent = vi.fn(async () => "sent" as const);
      const push = new Push(h.storage, async () => Response.json({ current: true }), true, sent);
      await push.deliver(
        request("POST", "/_baskule/push/deliver", {
          body: { spaceId, environmentId: "environment", notification: n },
        }),
      );
      expect(sent).not.toHaveBeenCalled();
      await call(h, "DELETE", `/api/baskule/push/devices/${deviceId}`, { creds: a.creds });
      const bSpace = personalSpaceOf(h, b.userId);
      await push.deliver(
        request("POST", "/_baskule/push/deliver", {
          body: {
            spaceId: bSpace,
            environmentId: "environment",
            notification: { ...n, userId: b.userId },
          },
        }),
      );
      expect(sent).toHaveBeenCalledTimes(1);
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ notification: expect.objectContaining({ userId: b.userId }) }),
      );
      const freshId = "fedcba9876543210fedcba9876543210";
      expect(
        (
          await call(h, "PUT", `/api/baskule/push/devices/${freshId}`, {
            creds: b.creds,
            body: enrollment,
          })
        ).status,
      ).toBe(200);
      expect(h.storage.sql.exec("select id,user_id from push_device").toArray()).toEqual([
        { id: freshId, user_id: b.userId },
      ]);
    },
  );

  it("fences an old account send when enrollment changes during provider authorization", async () => {
    const { h, a, put, spaceId, n } = await setup();
    await put();
    const b = await signIn(h, ADMIN.email, ADMIN.password);
    const externalSend = vi.fn();
    const push = new Push(
      h.storage,
      async () => Response.json({ current: true }),
      true,
      async (input) => {
        await put(registration, b.creds);
        if (await input.eligible()) externalSend();
        return "skipped";
      },
    );
    await push.deliver(
      request("POST", "/_baskule/push/deliver", {
        body: { spaceId, environmentId: "environment", notification: n },
      }),
    );
    expect(externalSend).not.toHaveBeenCalled();
    await call(h, "DELETE", `/api/baskule/push/devices/${deviceId}`, { creds: a.creds });
    expect(h.storage.sql.exec("select session_id from push_device").toArray()).toEqual([
      { session_id: b.sessionId },
    ]);
  });

  it("reports anonymous push unavailable", async () => {
    const h = await makeService({ AUTH_CONFIG: JSON.stringify({ mode: "anonymous" }) });
    expect(h.svc.push.status()).toMatchObject({ available: false, ios: null, android: null });
  });
});
