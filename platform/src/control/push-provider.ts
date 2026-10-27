import { z } from "zod";
import type {
  PushNotification,
  PushRegistration,
} from "../../../app/packages/contracts/src/baskulePush";

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const pushCredentialsSchema = z
  .object({
    apns: z
      .object({
        appId: id,
        teamId: id,
        keyId: id,
        privateKey: z.string().min(1).max(16000),
        environments: z.array(z.enum(["sandbox", "production"])).min(1),
      })
      .strict()
      .nullable(),
    fcm: z
      .object({
        appId: id,
        projectId: id,
        clientEmail: z.email(),
        privateKey: z.string().min(1).max(16000),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PushCredentials = z.infer<typeof pushCredentialsSchema>;
export type PushResult = "sent" | "invalid" | "skipped";
const enc = new TextEncoder();
const base64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

async function jwt(
  privateKey: string,
  header: object,
  claims: object,
  algorithm: "ES256" | "RS256",
) {
  const data = `${base64url(enc.encode(JSON.stringify(header)))}.${base64url(enc.encode(JSON.stringify(claims)))}`;
  const der = Uint8Array.from(atob(privateKey.replace(/-----[^-]+-----|\s/g, "")), (c) =>
    c.charCodeAt(0),
  );
  const algo =
    algorithm === "ES256"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("pkcs8", der, algo, false, ["sign"]);
  const signature = await crypto.subtle.sign(
    algorithm === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : algo,
    key,
    enc.encode(data),
  );
  return `${data}.${base64url(new Uint8Array(signature))}`;
}

export function androidPushData(
  deviceId: string,
  notification: PushNotification,
  environmentId: string,
) {
  return {
    t3_kind: "agent_activity",
    device_id: deviceId,
    user_id: notification.userId,
    updated_at: String(Date.now()),
    active: "false",
    alert_id: notification.eventId,
    alert_title: notification.title,
    alert_body: notification.body,
    alert_path: `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(notification.threadId)}`,
    alert_group: `${environmentId}:${notification.threadId}`,
  };
}

/** The runtime's fetch must negotiate HTTP/2 for api.push.apple.com. Provider acceptance is not device receipt. */
export async function sendPush(
  input: {
    credentials: PushCredentials;
    registration: PushRegistration;
    deviceId: string;
    notification: PushNotification;
    spaceId: string;
    environmentId: string;
    eligible: () => Promise<boolean>;
  },
  fetchFn: typeof fetch = fetch,
): Promise<PushResult> {
  const { credentials, registration: device, notification: n } = input;
  const now = Math.floor(Date.now() / 1000);
  if (device.platform === "ios") {
    const apns = credentials.apns;
    if (!apns || apns.appId !== device.appId || !apns.environments.includes(device.apnsEnvironment))
      return "skipped";
    const token = await jwt(
      apns.privateKey,
      { alg: "ES256", kid: apns.keyId },
      { iss: apns.teamId, iat: now },
      "ES256",
    );
    const collapseId = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(n.eventId))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (!(await input.eligible())) return "skipped";
    const response = await fetchFn(
      `https://${device.apnsEnvironment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com"}/3/device/${device.token}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: `bearer ${token}`,
          "apns-topic": apns.appId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(n.expiresAt / 1000)),
          "apns-collapse-id": collapseId,
        },
        body: JSON.stringify({
          aps: { alert: { title: n.title, body: n.body }, sound: "default" },
          eventId: n.eventId,
          spaceId: input.spaceId,
          environmentId: input.environmentId,
          deepLink: androidPushData(input.deviceId, n, input.environmentId).alert_path,
          threadId: n.threadId,
          threadPath: androidPushData(input.deviceId, n, input.environmentId).alert_path,
        }),
      },
    );
    if (response.ok) return "sent";
    const body: unknown = await response.json().catch(() => null);
    const reason = z.object({ reason: z.string() }).safeParse(body);
    if (
      response.status === 410 ||
      (response.status === 400 &&
        reason.success &&
        ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(reason.data.reason))
    )
      return "invalid";
    throw new Error(`APNs send failed (${response.status})`);
  }
  const fcm = credentials.fcm;
  if (!fcm || fcm.appId !== device.appId) return "skipped";
  const assertion = await jwt(
    fcm.privateKey,
    { alg: "RS256", typ: "JWT" },
    {
      iss: fcm.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    "RS256",
  );
  const auth = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!auth.ok) throw new Error(`FCM authorization failed (${auth.status})`);
  const access = z.object({ access_token: z.string().min(1) }).parse(await auth.json());
  if (!(await input.eligible())) return "skipped";
  const response = await fetchFn(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(fcm.projectId)}/messages:send`,
    {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: `Bearer ${access.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: device.token,
          data: androidPushData(input.deviceId, n, input.environmentId),
          android: {
            priority: "HIGH",
            ttl: `${Math.max(0, Math.min(300, Math.floor(n.expiresAt / 1000) - Math.floor(Date.now() / 1000)))}s`,
            restricted_package_name: fcm.appId,
          },
        },
      }),
    },
  );
  if (response.ok) return "sent";
  const error = z
    .object({
      error: z.object({
        details: z
          .array(z.object({ "@type": z.string().optional(), errorCode: z.string().optional() }))
          .optional(),
      }),
    })
    .safeParse(await response.json().catch(() => null));
  if (
    error.success &&
    error.data.error.details?.some(
      (d) =>
        d["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
        d.errorCode === "UNREGISTERED",
    )
  )
    return "invalid";
  throw new Error(`FCM send failed (${response.status})`);
}
