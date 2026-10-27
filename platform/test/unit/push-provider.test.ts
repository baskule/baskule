import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { sendPush, type PushCredentials } from "../../src/control/push-provider";
import type { PushRegistration } from "../../../app/packages/contracts/src/baskulePush";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const credentials: PushCredentials = {
  apns: {
    appId: "test.app",
    environments: ["sandbox"],
    teamId: "TEAM",
    keyId: "KEY",
    privateKey: ec,
  },
  fcm: { appId: "test.app", projectId: "project", clientEmail: "a@test.example", privateKey: rsa },
};
const preferences = {
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const notification = {
  eventId: "push:completion:run",
  userId: "alice",
  threadId: "thread",
  kind: "completion" as const,
  title: "Agent finished",
  body: "Chat",
  expiresAt: Date.now() + 300000,
};
const ios: PushRegistration = {
  platform: "ios",
  appId: "test.app",
  apnsEnvironment: "sandbox",
  token: "a".repeat(64),
  preferences,
};
const android: PushRegistration = {
  platform: "android",
  appId: "test.app",
  token: "fcm",
  preferences,
};
const input = (registration: PushRegistration) => ({
  credentials,
  registration,
  notification,
  deviceId: "device",
  spaceId: "space",
  environmentId: "environment",
  eligible: async () => true,
});
function jwtParts(token: string) {
  return token.split(".").map((p) => Buffer.from(p, "base64url"));
}

describe("push provider adapters", () => {
  it("signs APNs ES256 and sends an expiring alert to the configured sandbox topic", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("apns-topic")).toBe("test.app");
      expect(headers.get("apns-push-type")).toBe("alert");
      const parts = jwtParts(headers.get("authorization")!.slice(7));
      expect(JSON.parse(parts[0].toString())).toEqual({ alg: "ES256", kid: "KEY" });
      expect(JSON.parse(parts[1].toString())).toMatchObject({ iss: "TEAM" });
      expect(parts[2]).toHaveLength(64);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        aps: { alert: { title: "Agent finished", body: "Chat" } },
        threadPath: "/threads/environment/thread",
      });
      return new Response(null, { status: 200 });
    });
    expect(await sendPush(input(ios), fetchFn)).toBe("sent");
    expect(fetchFn.mock.calls[0][0]).toBe(
      `https://api.sandbox.push.apple.com/3/device/${ios.token}`,
    );
  });
  it("retains the native Android data contract and verifies eligibility after FCM OAuth", async () => {
    let eligible = true;
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("oauth2")) {
        const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
        expect(JSON.parse(jwtParts(assertion)[1].toString())).toMatchObject({
          iss: "a@test.example",
          aud: "https://oauth2.googleapis.com/token",
          scope: "https://www.googleapis.com/auth/firebase.messaging",
        });
        return Response.json({ access_token: "test-access" });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.message).toMatchObject({
        token: "fcm",
        data: {
          t3_kind: "agent_activity",
          device_id: "device",
          user_id: "alice",
          alert_id: "push:completion:run",
          alert_title: "Agent finished",
          alert_body: "Chat",
          alert_path: "/threads/environment/thread",
        },
        android: { restricted_package_name: "test.app", priority: "HIGH" },
      });
      expect(Number(body.message.data.updated_at)).toBeGreaterThan(0);
      expect(body.message.notification).toBeUndefined();
      return Response.json({ name: "accepted" });
    });
    expect(await sendPush({ ...input(android), eligible: async () => eligible }, fetchFn)).toBe(
      "sent",
    );
    eligible = false;
    expect(await sendPush({ ...input(android), eligible: async () => eligible }, fetchFn)).toBe(
      "skipped",
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it.each([400, 410])(
    "classifies APNs invalid tokens (%i), retaining other provider errors for retry",
    async (status) => {
      expect(
        await sendPush(input(ios), async () =>
          Response.json({ reason: "BadDeviceToken" }, { status }),
        ),
      ).toBe("invalid");
      await expect(
        sendPush(input(ios), async () =>
          Response.json({ reason: "TooManyRequests" }, { status: 429 }),
        ),
      ).rejects.toThrow("429");
    },
  );
  it("invalidates FCM only for the typed UNREGISTERED error", async () => {
    const response = (details: object[]) =>
      vi.fn<typeof fetch>(async (url) =>
        String(url).includes("oauth2")
          ? Response.json({ access_token: "test" })
          : Response.json({ error: { details } }, { status: 404 }),
      );
    expect(
      await sendPush(
        input(android),
        response([
          {
            "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
            errorCode: "UNREGISTERED",
          },
        ]),
      ),
    ).toBe("invalid");
    await expect(
      sendPush(input(android), response([{ errorCode: "UNREGISTERED" }])),
    ).rejects.toThrow("404");
  });
});
